// MOD-03: the event hub (contracts.ts EventHub). One SSE connection per bridge; events for
// tracked sessions (and their subagents) go through the state machine into the cursor buffer and
// to subscribers. On every (re)connect, in-stream gap or instance dispose the affected state is
// re-read from the server while stream events queue, and the queue is applied on top, so a gap can
// never be papered over by a stale snapshot or a lost `idle`.
import { BOX_DIRECTORY_RE, SESSION_ID_RE, type Cursor, type EventHub, type HubEvent, type InboxMessage, type SessionView } from "../shared/contracts.ts"
import { safeLog, silentLogger, type Logger } from "../shared/log.ts"
import { createApi, type ApiTarget, type OpencodeApi } from "../shared/opencode-api.ts"
import { EventBuffer, viewMatches, type Filter, type HubEventInput, type Page, type WaitInput, type WaitResult } from "./buffer.ts"
import { MessageMemory, errorLabel, inboxEvent, linkEvent, mcpEvent, rawEvent, resyncEvent, statusEvent } from "./describe.ts"
import { normalise, sessionOf, unwrap, type Raw } from "./normalise.ts"
import { readRemote, readSnapshot } from "./server.ts"
import { runStream, type Drop, type StreamControl } from "./sse.ts"
import { AUTO_CAP, NOT_STARTED_MS, SessionTable, type Change, type Link } from "./state.ts"
import { realTimers, type Timers } from "./timers.ts"
import { TRUSTED, entryView, failedView, remoteView } from "./view.ts"

export type HubOptions = {
  target: ApiTarget
  api?: OpencodeApi
  fetch?: typeof fetch
  timers?: Timers
  log?: Logger
  /** Track every session seen on the stream (watch CLI). The bridge tracks explicitly. */
  trackAll?: boolean
  /** Most auto-tracked sessions (trackAll, subagents) kept at once. */
  autoCap?: number
  capacity?: number
  backoffMs?: readonly number[]
  staleMs?: number
  healthyMs?: number
  notStartedMs?: number
  epoch?: string
}

export type Listener = (event: HubEvent) => void

/** EventHub plus two additive members: push subscribers (T3.5 channel, watch CLI) and inbox events (MOD-05). */
export interface DelegateHub extends EventHub {
  subscribe(listener: Listener): () => void
  /** An inbox message for this bridge becomes an `inbox` hub event (no session, no state). */
  publishInbox(message: InboxMessage): HubEvent
}

/** Stream events queued while a rebuild is in flight; more than this and the stream restarts. */
const MAX_QUEUED = 10_000
const MAX_QUEUED_CHARS = 32 * 1024 * 1024

type Scope = "all" | Set<string>
type Queue = { items: string[]; chars: number }

function merge(a: Scope | undefined, b: Scope): Scope {
  if (a === undefined) return b
  if (a === "all" || b === "all") return "all"
  return new Set([...a, ...b])
}

class Hub implements DelegateHub {
  private readonly timers: Timers
  private readonly log: Logger
  private readonly api: OpencodeApi
  private readonly table: SessionTable
  private readonly buffer: EventBuffer
  private readonly notStartedMs: number
  private readonly memory = new MessageMemory()
  private readonly listeners = new Set<Listener>()
  /** One not_started watchdog per session (W2A-01). */
  private readonly startTimers = new Map<string, () => void>()
  private stream: StreamControl | undefined
  private generation = 0
  private opened = false
  private closed = false
  private resyncPending = false
  private linkKind: Link["kind"] = "gap"
  private warnedCap = false
  private queue: Queue | undefined
  private scope: Scope | undefined
  private cause = "rebuild"
  private settle: (() => void) | undefined

  constructor(private readonly o: HubOptions) {
    this.timers = o.timers ?? realTimers
    this.log = o.log ?? silentLogger
    this.api = o.api ?? createApi(o.target, o.fetch)
    this.notStartedMs = o.notStartedMs ?? NOT_STARTED_MS
    this.table = new SessionTable(() => this.timers.now(), this.notStartedMs, o.autoCap ?? AUTO_CAP)
    this.buffer = new EventBuffer(o.epoch ?? crypto.randomUUID(), this.timers, o.capacity)
  }

  /** Resolves once the first connection attempt settles (rebuilt, or failed and reported). */
  start(): Promise<void> {
    if (this.stream) return Promise.resolve()
    const first = new Promise<void>((resolve) => (this.settle = resolve))
    const handlers = { onOpen: () => this.onOpen(), onData: (d: string) => this.onData(d), onDrop: (d: Drop) => this.onDrop(d), onGap: (d: string) => this.onGap(d) }
    const o = this.o
    this.stream = runStream(o.target, handlers, { timers: this.timers, fetch: o.fetch, backoffMs: o.backoffMs, staleMs: o.staleMs, healthyMs: o.healthyMs })
    return first
  }

  async stop(): Promise<void> {
    this.closed = true
    const stream = this.stream
    this.stream = undefined
    this.generation++
    await stream?.stop()
    for (const cancel of this.startTimers.values()) cancel()
    this.startTimers.clear()
    this.buffer.close()
    this.settled()
  }

  track(sessionID: string, directory: string): void {
    if (this.table.track(sessionID, directory)) safeLog(this.log, "debug", "events", "tracking session", { sessionID, directory })
  }

  markSent(sessionID: string): void {
    this.cancelStart(sessionID)
    this.emitChanges(this.table.markSent(sessionID))
    if (!this.table.awaitingStart(sessionID)) return
    const cancel = this.timers.setTimeout(() => {
      this.startTimers.delete(sessionID)
      this.emitChanges(this.table.startTimeout(sessionID))
    }, this.notStartedMs)
    this.startTimers.set(sessionID, cancel)
  }

  cursor(): Cursor {
    return this.buffer.head()
  }

  async view(sessionID: string): Promise<SessionView> {
    const known = this.table.get(sessionID)
    if (known && TRUSTED.has(known.state)) return entryView(known)
    const detail = known ? `read from the server (hub state ${known.state})` : "read from the server"
    try {
      const remote = await readRemote(this.api, sessionID, known?.reportedDirectory ?? known?.directory)
      return remoteView(sessionID, remote, this.timers.now(), detail, known)
    } catch (error) {
      const view = failedView(sessionID, known?.directory ?? "", error, this.timers.now())
      safeLog(this.log, "warn", "events", "view could not read the server", { sessionID, state: view.state, detail: view.detail })
      return view
    }
  }

  events(cursor: Cursor | undefined, filter?: Filter, limit?: number): Page {
    return this.buffer.page(cursor, filter, limit)
  }

  /** Events first; without a cursor, and again before a timeout, the current state (W2A-05/06). */
  async wait(input: WaitInput): Promise<WaitResult> {
    const cursor = input.cursor ?? this.buffer.head()
    if (!input.cursor) {
      const views = await this.matchingViews(input)
      if (views.length) return { events: [], next: cursor, timedOut: false, views }
    }
    const result = await this.buffer.wait({ ...input, cursor })
    if (!result.timedOut || this.closed) return result
    const views = await this.matchingViews(input)
    return views.length ? { ...result, timedOut: false, views } : result
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publishInbox(message: InboxMessage): HubEvent {
    return this.publish(inboxEvent(message))
  }

  private async matchingViews(input: WaitInput): Promise<SessionView[]> {
    if (input.sessionIDs.length === 0 || this.closed) return []
    const views = await Promise.all(input.sessionIDs.map((id) => this.view(id)))
    return views.filter((v) => input.until.some((u) => viewMatches(v, u)))
  }

  private publish(input: HubEventInput): HubEvent {
    // R3-03: subagent and moved-session directories come from the box; keep only a well-formed box path.
    const { directory, ...rest } = input
    const event = this.buffer.append(directory === undefined || BOX_DIRECTORY_RE.test(directory) ? input : rest)
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        safeLog(this.log, "warn", "events", "subscriber threw", { error: error instanceof Error ? error.name : "unknown" })
      }
    }
    return event
  }

  private settled(): void {
    const settle = this.settle
    this.settle = undefined
    settle?.()
  }

  private emitChanges(changes: Change[], cause?: string): void {
    for (const change of changes) this.publish(statusEvent(change, cause))
  }

  /** A hub-level `link` event whenever the link kind changes (W2A-11). */
  private linkChanged(): void {
    const link = this.table.linkState()
    if (link.kind === this.linkKind) return
    this.linkKind = link.kind
    this.publish(linkEvent(link))
  }

  private cancelStart(sessionID: string): void {
    this.startTimers.get(sessionID)?.()
    this.startTimers.delete(sessionID)
  }

  /** A busy (or anything that proves the prompt ran) ends that session's watchdog. */
  private syncStartTimers(sessionID?: string): void {
    const ids = sessionID === undefined ? [...this.startTimers.keys()] : [sessionID]
    for (const id of ids) if (this.startTimers.has(id) && !this.table.awaitingStart(id)) this.cancelStart(id)
  }

  private onOpen(): void {
    this.resyncPending = this.opened
    safeLog(this.log, "info", "events", "event stream connected; rebuilding state", { sessions: this.table.size() })
    this.beginRebuild("all", "rebuild")
  }

  /** Events were lost inside the live stream: everything is unknown until re-read. */
  private onGap(detail: string): void {
    safeLog(this.log, "warn", "events", "events lost inside the stream; rebuilding state", { detail })
    this.emitChanges(this.table.markGap("all", detail), "a stream gap")
    this.beginRebuild("all", "a stream gap")
  }

  /** Re-read `scope` while stream events queue. A second request merges into the one in flight. */
  private beginRebuild(scope: Scope, cause: string): void {
    const gen = ++this.generation
    if (!this.queue) this.cause = cause
    this.queue ??= { items: [], chars: 0 }
    this.scope = merge(this.scope, scope)
    void this.rebuild(gen, this.scope)
  }

  private async rebuild(gen: number, scope: Scope): Promise<void> {
    const tracked = this.table.tracked().filter((t) => scope === "all" || scope.has(t.directory))
    const snap = await readSnapshot(this.api, tracked, (id) => this.table.has(id)).catch(() => undefined)
    if (gen !== this.generation) return
    const everything = tracked.length + (snap?.children.length ?? 0)
    if (!snap || (scope === "all" && everything > 0 && snap.failed.size >= everything)) {
      safeLog(this.log, "warn", "events", "state rebuild failed; reconnecting", { sessions: tracked.length, reason: snap?.failed.values().next().value })
      this.queue = undefined
      this.scope = undefined
      this.stream?.restart()
      return
    }
    for (const child of snap.children) this.table.autoTrack(child.sessionID, child.directory, child.parentID)
    this.finishRebuild(scope, this.table.rebuild(snap.entries, snap.failed))
  }

  private finishRebuild(scope: Scope, changes: Change[]): void {
    // The first connect only learns the starting state (view() shows it); it is not news.
    const news = this.opened || scope !== "all"
    if (scope === "all") this.opened = true
    this.linkChanged()
    if (this.resyncPending && scope === "all") this.publish(resyncEvent(this.table.size()))
    if (scope === "all") this.resyncPending = false
    if (news) this.emitChanges(changes, this.cause)
    const queued = this.queue?.items ?? []
    this.queue = undefined
    this.scope = undefined
    for (const data of queued) this.ingest(data)
    this.syncStartTimers()
    this.stream?.healthy()
    this.settled()
  }

  private onData(data: string): void {
    if (!this.queue) return this.ingest(data)
    this.queue.items.push(data)
    this.queue.chars += data.length
    if (this.queue.items.length > MAX_QUEUED || this.queue.chars > MAX_QUEUED_CHARS) {
      safeLog(this.log, "warn", "events", "too many events queued during rebuild; reconnecting", { events: this.queue.items.length, chars: this.queue.chars })
      this.queue = undefined
      this.scope = undefined
      this.stream?.restart()
    }
  }

  private onDrop(drop: Drop): void {
    this.generation++
    this.queue = undefined
    this.scope = undefined
    const link = drop.kind === "unreachable" ? { kind: "down" as const, detail: `server unreachable (${drop.detail})` } : { kind: "gap" as const, detail: `${drop.kind}: ${drop.detail}` }
    const loud = drop.kind === "unreachable" || drop.kind === "http"
    safeLog(this.log, loud ? "warn" : "info", "events", "event stream dropped", { kind: drop.kind, detail: drop.detail })
    const changes = this.table.setLink(link)
    this.linkChanged()
    this.emitChanges(changes, `stream ${drop.kind}`)
    this.settled()
  }

  private ingest(data: string): void {
    const wrapper = unwrap(data)
    if (!wrapper) return
    const raw = normalise(wrapper)
    if (raw.kind === "mcp") {
      if (wrapper.directory && this.table.directories().includes(wrapper.directory)) this.publish(mcpEvent(raw.server, wrapper.directory))
      return
    }
    if (raw.kind === "disposed") return this.disposed(raw.directory)
    if (raw.kind === "error" && !raw.sessionID) {
      safeLog(this.log, "warn", "events", "the server reported an error without a session", { error: errorLabel(raw.name), directory: wrapper.directory })
      return
    }
    const sessionID = sessionOf(raw)
    if (!sessionID) return
    if (!this.table.has(sessionID) && !this.adopt(raw, sessionID, wrapper.directory)) return
    this.apply(raw, sessionID)
    this.syncStartTimers(sessionID)
  }

  /** Track a session the bridge did not: a subagent of a tracked session, or anything under trackAll. */
  private adopt(raw: Raw, sessionID: string, wrapperDirectory: string | undefined): boolean {
    const parentID = raw.kind === "info" && raw.parentID && this.table.has(raw.parentID) ? raw.parentID : undefined
    const directory = (raw.kind === "info" ? raw.directory : undefined) ?? wrapperDirectory
    if (!directory || !SESSION_ID_RE.test(sessionID) || (!parentID && !this.o.trackAll)) return false
    if (this.table.autoTrack(sessionID, directory, parentID)) return true
    if (!this.warnedCap) safeLog(this.log, "warn", "events", "too many sessions to track; new ones are ignored until older ones settle", { cap: this.o.autoCap ?? AUTO_CAP })
    this.warnedCap = true
    return false
  }

  /** The instance for a directory (or every instance) went away: runs there may have ended unseen (W2A-10). */
  private disposed(directory: string): void {
    const all = directory === "all"
    if (!all && !this.table.directories().includes(directory)) return
    const scope: Scope = all ? "all" : new Set([directory])
    safeLog(this.log, "info", "events", "server instance disposed; re-reading state", { directory })
    this.emitChanges(this.table.markGap(scope, all ? "the server disposed every instance" : "the directory's instance was disposed"), "a dispose")
    this.beginRebuild(scope, "a re-read")
  }

  private apply(raw: Raw, id: string): void {
    switch (raw.kind) {
      case "info":
        if (raw.parentID) this.emitChanges(this.table.setParent(id, raw.parentID))
        return
      case "status":
        return this.emitChanges(this.table.status(id, raw.status, raw.attempt))
      case "error":
        this.emitOthers(this.table.error(id, errorLabel(raw.name), raw.aborted), id)
        return this.news(raw, id)
      case "permission.asked":
      case "question.asked":
        this.emitOthers(this.table.ask(id, raw.requestID, raw.kind === "permission.asked" ? "permission" : "question"), id)
        return this.news(raw, id)
      case "permission.replied":
      case "question.done":
        return this.emitChanges(this.table.answered(id, raw.requestID), "an answer")
      case "message.role":
        return this.memory.role(raw.messageID, raw.role)
      case "text.final":
        if (this.memory.shouldReport(raw.messageID, raw.partID)) this.news(raw, id)
        return
      case "todo":
        return this.news(raw, id)
      case "deleted":
        return this.emitChanges(this.table.deleted(id))
    }
  }

  /** The session's own change is carried by its specific event; its ancestors' (roll-up) are not. */
  private emitOthers(changes: Change[], id: string): void {
    this.emitChanges(changes.filter((c) => c.sessionID !== id))
  }

  private news(raw: Parameters<typeof rawEvent>[0], id: string): void {
    const e = this.table.get(id)
    if (e) this.publish(rawEvent(raw, { sessionID: id, directory: e.directory, state: e.state, parentID: e.parentID }))
  }
}

export function createHub(options: HubOptions): DelegateHub {
  return new Hub(options)
}
