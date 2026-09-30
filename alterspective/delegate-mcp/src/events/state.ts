// MOD-03 T3.2: the session state machine (technical-design §6, plan §5 FM-0).
//   starting → busy ⇄ retry → idle | error | aborted, and needs_input while a permission or
//   question is pending — its own or a subagent's (even when upstream still says busy).
// Absent data is a state, never a guess:
//   - the link is down            → every tracked session is `server_down`
//   - the stream dropped          → every tracked session is `unknown` (stream_gap) until rebuilt
//   - a directory was disposed or
//     its rebuild read failed     → that directory's sessions are `unknown` until re-read
//   - sent, no busy in 10 s       → `not_started` (anomalyco/opencode#26635)
//   - nothing learned yet         → `unresolved` (internal): view() must ask the server, never say idle
// session.error is not final by itself (overflow compaction and file-read errors carry on,
// session/processor.ts:627-630, session/prompt.ts:894-897): it becomes the state only when idle
// follows with no busy in between. OpenCode drops pending requests silently on abort/dispose
// (permission/index.ts:98-110, question/index.ts:104-110), so idle and abort clear them.
// Pure: no I/O and no timers; the hub feeds it events and the clock.
import type { SessionState } from "../shared/contracts.ts"

export type Base = "unresolved" | "starting" | "busy" | "retry" | "idle" | "error" | "aborted" | "not_started" | "not_found"
export type Derived = SessionState | "unresolved"
export type Link = { kind: "up" } | { kind: "gap"; detail: string } | { kind: "down"; detail: string }
export type PendingKind = "permission" | "question"
export type Change = { sessionID: string; directory: string; state: Derived; detail?: string; parentID?: string }
export type SnapshotEntry = {
  base: "busy" | "retry" | "idle" | "not_found"
  detail?: string
  pending: Array<{ requestID: string; kind: PendingKind }>
  /** The session's real directory when it differs from the tracked one. */
  directory?: string
}
export type EntryView = { sessionID: string; directory: string; state: Derived; detail?: string; since: number; pending: string[]; parentID?: string; lastError?: string }
export type Tracked = { sessionID: string; directory: string }

export const NOT_STARTED_MS = 10_000
/** A busy seen at most this long before markSent counts as the start: the busy event can beat the 204. */
export const SENT_SLACK_MS = 2000
/** not_found entries are forgotten after this (W2A-22). */
export const PRUNE_MS = 10 * 60_000
/** Auto-tracked sessions (trackAll, subagents) beyond this evict the oldest settled one (W2A-22). */
export const AUTO_CAP = 500
const GAP_CAVEAT = "idle after a stream gap; a later run cannot be ruled out"
const SETTLED = new Set<Derived>(["unresolved", "idle", "error", "aborted", "not_started", "not_found"])

type Entry = {
  sessionID: string
  directory: string
  parentID?: string
  children: Set<string>
  auto: boolean
  base: Base
  detail?: string
  pending: Map<string, PendingKind>
  awaitingStart: boolean
  sentAt?: number
  lastActiveAt?: number
  /** Last session.error; `armed` until a busy shows the run carried on. */
  lastError?: { label: string; aborted: boolean; armed: boolean }
  /** Per-entry gap (disposed directory, failed rebuild read). */
  gap?: string
  state: Derived
  stateDetail?: string
  since: number
}

export class SessionTable {
  private readonly entries = new Map<string, Entry>()
  private link: Link = { kind: "gap", detail: "not connected yet" }

  constructor(
    private readonly now: () => number,
    private readonly notStartedMs: number = NOT_STARTED_MS,
    private readonly autoCap: number = AUTO_CAP,
  ) {}

  /** Explicit tracking (the bridge). Returns false when already tracked. */
  track(sessionID: string, directory: string, parentID?: string): boolean {
    this.prune()
    return this.add(sessionID, directory, parentID, false)
  }

  /** Tracking the hub decided on (trackAll, subagents): capped. False when refused or already tracked. */
  autoTrack(sessionID: string, directory: string, parentID?: string): boolean {
    if (this.entries.has(sessionID)) return false
    this.prune()
    if (this.autoCount() >= this.autoCap && !this.evictOne()) return false
    return this.add(sessionID, directory, parentID, true)
  }

  /** Link a tracked session to its parent (session.created/updated carried parentID). */
  setParent(sessionID: string, parentID: string): Change[] {
    const e = this.entries.get(sessionID)
    const parent = this.entries.get(parentID)
    if (!e || !parent || e.parentID || sessionID === parentID) return []
    e.parentID = parentID
    parent.children.add(sessionID)
    return this.refresh(e)
  }

  has(sessionID: string): boolean {
    return this.entries.has(sessionID)
  }

  size(): number {
    return this.entries.size
  }

  get(sessionID: string): EntryView | undefined {
    const e = this.entries.get(sessionID)
    if (!e) return undefined
    const view: EntryView = { sessionID, directory: e.directory, state: e.state, detail: e.stateDetail, since: e.since, pending: this.pendingOf(e) }
    if (e.parentID) view.parentID = e.parentID
    if (e.lastError) view.lastError = e.lastError.label
    return view
  }

  tracked(): Tracked[] {
    return [...this.entries.values()].map((e) => ({ sessionID: e.sessionID, directory: e.directory }))
  }

  directories(): string[] {
    return [...new Set([...this.entries.values()].map((e) => e.directory))]
  }

  linkState(): Link {
    return this.link
  }

  /** prompt_async was accepted: expect busy within the window, unless it is already running. */
  markSent(sessionID: string): Change[] {
    const e = this.entries.get(sessionID)
    if (!e) return []
    if (e.base === "busy" || e.base === "retry" || e.pending.size > 0) return []
    if (e.lastActiveAt !== undefined && this.now() - e.lastActiveAt <= SENT_SLACK_MS) return []
    e.base = "starting"
    e.detail = undefined
    e.awaitingStart = true
    e.sentAt = this.now()
    return this.refresh(e)
  }

  awaitingStart(sessionID: string): boolean {
    return this.entries.get(sessionID)?.awaitingStart === true
  }

  /** The not_started watchdog fired. During a gap, or before the window has passed, nothing is claimed. */
  startTimeout(sessionID: string): Change[] {
    const e = this.entries.get(sessionID)
    if (!e?.awaitingStart || this.link.kind !== "up" || e.gap) return []
    if (this.now() - (e.sentAt ?? 0) < this.notStartedMs) return []
    e.awaitingStart = false
    e.base = "not_started"
    e.detail = `prompt accepted but no busy within ${this.notStartedMs / 1000} s`
    return this.refresh(e)
  }

  setLink(link: Link): Change[] {
    this.link = link
    return this.refreshAll()
  }

  /** Mark directories (or all) as gapped: their sessions are unknown until re-read. */
  markGap(directories: ReadonlySet<string> | "all", detail: string): Change[] {
    for (const e of this.entries.values()) if (directories === "all" || directories.has(e.directory)) e.gap = detail
    return this.refreshAll()
  }

  status(sessionID: string, status: "idle" | "busy" | "retry", attempt?: number): Change[] {
    const e = this.entries.get(sessionID)
    if (!e) return []
    if (status === "idle") return this.idle(e)
    this.running(e)
    e.base = status
    e.detail = status === "retry" && attempt !== undefined ? `retry attempt ${attempt}` : undefined
    return this.refresh(e)
  }

  /** Record a session.error (label = known name or "unrecognised error"); state waits for idle. */
  error(sessionID: string, label: string, aborted: boolean): Change[] {
    const e = this.entries.get(sessionID)
    if (!e) return []
    e.awaitingStart = false
    e.lastError = { label, aborted, armed: true }
    if (!aborted) return []
    e.pending.clear()
    return this.refresh(e)
  }

  ask(sessionID: string, requestID: string, kind: PendingKind): Change[] {
    const e = this.entries.get(sessionID)
    if (!e) return []
    e.awaitingStart = false
    e.pending.set(requestID, kind)
    return this.refresh(e)
  }

  answered(sessionID: string, requestID: string): Change[] {
    const e = this.entries.get(sessionID)
    if (!e || !e.pending.delete(requestID)) return []
    return this.refresh(e)
  }

  deleted(sessionID: string): Change[] {
    const e = this.entries.get(sessionID)
    if (!e) return []
    e.base = "not_found"
    e.detail = "session deleted"
    e.pending.clear()
    e.awaitingStart = false
    e.gap = undefined
    return this.refresh(e)
  }

  /**
   * Server truth after a (re)connect or a directory re-read. `failed` sessions stay unknown with
   * the reason; sessions in neither map keep what they had.
   */
  rebuild(snapshot: Map<string, SnapshotEntry>, failed: Map<string, string> = new Map()): Change[] {
    this.link = { kind: "up" }
    for (const e of this.entries.values()) {
      const s = snapshot.get(e.sessionID)
      const why = failed.get(e.sessionID)
      if (s) this.applySnapshot(e, s)
      else if (why !== undefined) e.gap = why
    }
    return this.refreshAll()
  }

  private applySnapshot(e: Entry, s: SnapshotEntry): void {
    e.gap = undefined
    if (s.directory) e.directory = s.directory
    e.pending = new Map(s.pending.map((p) => [p.requestID, p.kind]))
    if (s.base === "busy" || s.base === "retry") this.running(e)
    else if (e.pending.size > 0) e.awaitingStart = false
    if (s.base === "idle" && e.pending.size === 0) return this.idleAfterGap(e)
    e.awaitingStart = false
    e.base = s.base
    e.detail = s.detail
  }

  /** Idle now, and the hub did not see how the last run ended. */
  private idleAfterGap(e: Entry): void {
    if (e.awaitingStart) {
      // Finished during the gap, or never started: unknowable, so keep the conservative claim.
      if (this.now() - (e.sentAt ?? 0) < this.notStartedMs) return
      e.awaitingStart = false
      e.base = "not_started"
      e.detail = "idle after a stream gap; the prompt was never seen running"
      return
    }
    // A failure the hub saw (or an error still waiting for its idle) is not turned into bare idle (W2A-07).
    const err = e.lastError
    if (err && (err.armed || e.base === "error" || e.base === "aborted")) {
      e.base = err.aborted ? "aborted" : "error"
      e.detail = `${err.label}; ${GAP_CAVEAT}`
      err.armed = false
      return
    }
    e.base = "idle"
    e.detail = undefined
  }

  private idle(e: Entry): Change[] {
    e.pending.clear()
    e.gap = undefined
    const err = e.lastError
    if (err?.armed) {
      e.base = err.aborted ? "aborted" : "error"
      e.detail = err.label
      err.armed = false
    } else if (e.base !== "error" && e.base !== "aborted") {
      // error/aborted stay visible through repeated idles; only a new run (busy) clears them.
      e.base = "idle"
      e.detail = undefined
    }
    return this.refresh(e)
  }

  /** Only busy/retry prove a run: they end the start wait, disarm an earlier error and count as activity. */
  private running(e: Entry): void {
    e.awaitingStart = false
    e.lastActiveAt = this.now()
    if (e.lastError) e.lastError.armed = false
  }

  private add(sessionID: string, directory: string, parentID: string | undefined, auto: boolean): boolean {
    if (this.entries.has(sessionID)) return false
    const e: Entry = { sessionID, directory, children: new Set(), auto, base: "unresolved", pending: new Map(), awaitingStart: false, state: "unresolved", since: this.now() }
    const parent = parentID === undefined ? undefined : this.entries.get(parentID)
    if (parent && parentID !== sessionID) {
      e.parentID = parentID
      parent.children.add(sessionID)
    }
    this.entries.set(sessionID, e)
    ;[e.state, e.stateDetail] = this.derive(e)
    return true
  }

  private autoCount(): number {
    let n = 0
    for (const e of this.entries.values()) if (e.auto) n++
    return n
  }

  /** Forget the oldest settled auto-tracked session with no children. */
  private evictOne(): boolean {
    let oldest: Entry | undefined
    for (const e of this.entries.values()) {
      if (!e.auto || e.children.size > 0 || !SETTLED.has(e.state)) continue
      if (!oldest || e.since < oldest.since) oldest = e
    }
    if (oldest) this.remove(oldest)
    return oldest !== undefined
  }

  private prune(): void {
    const cutoff = this.now() - PRUNE_MS
    for (const e of [...this.entries.values()]) if (e.state === "not_found" && e.since <= cutoff && e.children.size === 0) this.remove(e)
  }

  private remove(e: Entry): void {
    this.entries.delete(e.sessionID)
    if (e.parentID) this.entries.get(e.parentID)?.children.delete(e.sessionID)
  }

  /** Own pending ids, then every descendant's (a parent waits on its subagents' requests). */
  private pendingOf(e: Entry, seen = new Set<string>()): string[] {
    seen.add(e.sessionID)
    const out = [...e.pending.keys()]
    for (const id of e.children) {
      const child = this.entries.get(id)
      if (child && !seen.has(id)) out.push(...this.pendingOf(child, seen))
    }
    return out
  }

  /** The first descendant with a pending request, for the parent's detail. */
  private askingChild(e: Entry, seen = new Set<string>()): string | undefined {
    seen.add(e.sessionID)
    for (const id of e.children) {
      const child = this.entries.get(id)
      if (!child || seen.has(id)) continue
      if (child.pending.size > 0 && child.base !== "not_found") return id
      const deeper = this.askingChild(child, seen)
      if (deeper) return deeper
    }
    return undefined
  }

  private derive(e: Entry): [Derived, string | undefined] {
    if (this.link.kind === "down") return ["server_down", this.link.detail]
    if (this.link.kind === "gap") return ["unknown", `stream_gap: ${this.link.detail}`]
    if (e.gap) return ["unknown", `stream_gap: ${e.gap}`]
    if (e.base === "not_found") return [e.base, e.detail]
    if (e.pending.size > 0) return ["needs_input", `${e.pending.size} pending`]
    const child = this.askingChild(e)
    if (child) return ["needs_input", `subagent ${child} asks`]
    return [e.base, e.detail]
  }

  private refreshAll(): Change[] {
    return [...this.entries.values()].flatMap((e) => this.refreshOne(e))
  }

  /** Refresh one entry and its ancestors (their needs_input depends on this one's pending). */
  private refresh(e: Entry): Change[] {
    const changes = this.refreshOne(e)
    const seen = new Set([e.sessionID])
    for (let p = e.parentID ? this.entries.get(e.parentID) : undefined; p && !seen.has(p.sessionID); p = p.parentID ? this.entries.get(p.parentID) : undefined) {
      seen.add(p.sessionID)
      changes.push(...this.refreshOne(p))
    }
    return changes
  }

  private refreshOne(e: Entry): Change[] {
    const [state, detail] = this.derive(e)
    e.stateDetail = detail
    if (state === e.state) return []
    e.state = state
    e.since = this.now()
    const change: Change = { sessionID: e.sessionID, directory: e.directory, state, detail }
    if (e.parentID) change.parentID = e.parentID
    return [change]
  }
}
