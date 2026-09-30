// MOD-03 T3.2: the session state machine (technical-design §6, plan §5 FM-0).
//   starting → busy ⇄ retry → idle | error | aborted, and needs_input while a permission or
//   question is pending (even when upstream still says busy).
// Absent data is a state, never a guess:
//   - the link is down        → every tracked session is `server_down`
//   - the stream dropped      → every tracked session is `unknown` (stream_gap) until rebuilt
//   - sent, no busy in 10 s   → `not_started` (anomalyco/opencode#26635)
//   - nothing learned yet     → `unresolved` (internal): view() must ask the server, never say idle
// Pure: no I/O and no timers; the hub feeds it events and the clock.
import type { SessionState } from "../shared/contracts.ts"

export type Base = "unresolved" | "starting" | "busy" | "retry" | "idle" | "error" | "aborted" | "not_started" | "not_found"
export type Derived = SessionState | "unresolved"
export type Link = { kind: "up" } | { kind: "gap"; detail: string } | { kind: "down"; detail: string }
export type PendingKind = "permission" | "question"
export type Change = { sessionID: string; directory: string; state: Derived; detail?: string }
export type SnapshotEntry = { base: "busy" | "retry" | "idle" | "not_found"; detail?: string; pending: Array<{ requestID: string; kind: PendingKind }> }
export type EntryView = { sessionID: string; directory: string; state: Derived; detail?: string; since: number; pending: string[] }

export const NOT_STARTED_MS = 10_000
/** A busy seen at most this long before markSent counts as the start: the busy event can beat the 204. */
export const SENT_SLACK_MS = 2000

type Entry = {
  sessionID: string
  directory: string
  base: Base
  detail?: string
  pending: Map<string, PendingKind>
  awaitingStart: boolean
  sentAt?: number
  lastActiveAt?: number
  state: Derived
  stateDetail?: string
  since: number
}

function derive(e: Entry, link: Link): [Derived, string | undefined] {
  if (link.kind === "down") return ["server_down", link.detail]
  if (link.kind === "gap") return ["unknown", `stream_gap: ${link.detail}`]
  if (e.pending.size > 0 && e.base !== "not_found") return ["needs_input", `${e.pending.size} pending`]
  return [e.base, e.detail]
}

export class SessionTable {
  private readonly entries = new Map<string, Entry>()
  private link: Link = { kind: "gap", detail: "not connected yet" }

  constructor(
    private readonly now: () => number,
    private readonly notStartedMs: number = NOT_STARTED_MS,
  ) {}

  track(sessionID: string, directory: string): boolean {
    if (this.entries.has(sessionID)) return false
    const e: Entry = { sessionID, directory, base: "unresolved", pending: new Map(), awaitingStart: false, state: "unresolved", since: this.now() }
    ;[e.state, e.stateDetail] = derive(e, this.link)
    this.entries.set(sessionID, e)
    return true
  }

  has(sessionID: string): boolean {
    return this.entries.has(sessionID)
  }

  get(sessionID: string): EntryView | undefined {
    const e = this.entries.get(sessionID)
    if (!e) return undefined
    return { sessionID, directory: e.directory, state: e.state, detail: e.stateDetail, since: e.since, pending: [...e.pending.keys()] }
  }

  tracked(): Array<{ sessionID: string; directory: string }> {
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

  /** The not_started watchdog fired. During a gap nothing is claimed: rebuild decides. */
  startTimeout(sessionID: string): Change[] {
    const e = this.entries.get(sessionID)
    if (!e?.awaitingStart || this.link.kind !== "up") return []
    e.awaitingStart = false
    e.base = "not_started"
    e.detail = `prompt accepted but no busy within ${this.notStartedMs / 1000} s`
    return this.refresh(e)
  }

  setLink(link: Link): Change[] {
    this.link = link
    return [...this.entries.values()].flatMap((e) => this.refresh(e))
  }

  status(sessionID: string, status: "idle" | "busy" | "retry", attempt?: number): Change[] {
    const e = this.entries.get(sessionID)
    if (!e) return []
    if (status === "idle") {
      // error/aborted stay visible: OpenCode always follows session.error with status idle.
      if (e.base !== "error" && e.base !== "aborted") {
        e.base = "idle"
        e.detail = undefined
      }
      return this.refresh(e)
    }
    this.active(e)
    e.base = status
    e.detail = status === "retry" && attempt !== undefined ? `retry attempt ${attempt}` : undefined
    return this.refresh(e)
  }

  error(sessionID: string, name: string, aborted: boolean): Change[] {
    const e = this.entries.get(sessionID)
    if (!e) return []
    this.active(e)
    e.base = aborted ? "aborted" : "error"
    e.detail = name
    return this.refresh(e)
  }

  ask(sessionID: string, requestID: string, kind: PendingKind): Change[] {
    const e = this.entries.get(sessionID)
    if (!e) return []
    this.active(e)
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
    return this.refresh(e)
  }

  /** Server truth after a (re)connect. Sessions missing from the snapshot keep what they had. */
  rebuild(snapshot: Map<string, SnapshotEntry>): Change[] {
    this.link = { kind: "up" }
    for (const e of this.entries.values()) {
      const s = snapshot.get(e.sessionID)
      if (s) this.applySnapshot(e, s)
    }
    return [...this.entries.values()].flatMap((e) => this.refresh(e))
  }

  private applySnapshot(e: Entry, s: SnapshotEntry): void {
    e.pending = new Map(s.pending.map((p) => [p.requestID, p.kind]))
    const running = s.base === "busy" || s.base === "retry" || e.pending.size > 0
    if (running) this.active(e)
    if (e.awaitingStart && !running && s.base === "idle") {
      // Idle now, and no start was ever observed: finished during the gap, or never started.
      // Unknowable, so keep the conservative claim (not_started once the window has passed).
      const elapsed = this.now() - (e.sentAt ?? 0)
      if (elapsed < this.notStartedMs) return
      e.awaitingStart = false
      e.base = "not_started"
      e.detail = "idle after a stream gap; the prompt was never seen running"
      return
    }
    e.awaitingStart = false
    e.base = s.base
    e.detail = s.detail
  }

  private active(e: Entry): void {
    e.awaitingStart = false
    e.lastActiveAt = this.now()
  }

  private refresh(e: Entry): Change[] {
    const [state, detail] = derive(e, this.link)
    e.stateDetail = detail
    if (state === e.state) return []
    e.state = state
    e.since = this.now()
    return [{ sessionID: e.sessionID, directory: e.directory, state, detail }]
  }
}
