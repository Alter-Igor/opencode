// MOD-03: the event hub (contracts.ts EventHub). One SSE connection per bridge; events for
// tracked sessions go through the state machine into the cursor buffer and to subscribers.
// On every (re)connect the state is rebuilt from the server before queued stream events are
// applied, so a gap can never be papered over by a stale snapshot or a lost `idle`.
import type { Cursor, EventHub, HubEvent, SessionView } from "../shared/contracts.ts"
import { isDelegateError } from "../shared/errors.ts"
import { safeLog, silentLogger, type Logger } from "../shared/log.ts"
import { createApi, type ApiTarget, type OpencodeApi } from "../shared/opencode-api.ts"
import { EventBuffer, type Filter, type HubEventInput, type Page, type WaitInput, type WaitResult } from "./buffer.ts"
import { MessageMemory, mcpEvent, rawEvent, resyncEvent, statusEvent } from "./describe.ts"
import { normalise, sessionOf, unwrap, type Raw } from "./normalise.ts"
import { readRemote, readSnapshot, type Remote } from "./server.ts"
import { runStream, type Drop, type StreamControl } from "./sse.ts"
import { NOT_STARTED_MS, SessionTable, type Change, type EntryView, type SnapshotEntry } from "./state.ts"
import { realTimers, type Timers } from "./timers.ts"

export type HubOptions = {
  target: ApiTarget
  api?: OpencodeApi
  fetch?: typeof fetch
  timers?: Timers
  log?: Logger
  /** Track every session seen on the stream (watch CLI). The bridge tracks explicitly. */
  trackAll?: boolean
  capacity?: number
  backoffMs?: readonly number[]
  staleMs?: number
  notStartedMs?: number
  epoch?: string
}

export type Listener = (event: HubEvent) => void

/** EventHub plus two additive members: push subscribers (T3.5 channel, watch CLI) and publish (MOD-05 inbox). */
export interface DelegateHub extends EventHub {
  subscribe(listener: Listener): () => void
  publish(event: HubEventInput): HubEvent
}

/** Stream events queued while a rebuild is in flight; more than this and the rebuild restarts. */
const MAX_QUEUED = 10_000
const TRUSTED = new Set(["starting", "busy", "retry", "needs_input", "idle", "error", "aborted", "not_started", "not_found"])

const iso = (ms: number) => new Date(ms).toISOString()

function entryView(e: EntryView): SessionView {
  const view: SessionView = { sessionID: e.sessionID, directory: e.directory, state: e.state === "unresolved" ? "unknown" : e.state, since: iso(e.since) }
  if (e.detail) view.detail = e.detail
  if (e.pending.length) view.pending = e.pending
  return view
}

function remoteView(sessionID: string, remote: Remote, now: number, detail: string): SessionView {
  const { entry } = remote
  const waiting = entry.pending.length > 0 && entry.base !== "not_found"
  const view: SessionView = { sessionID, directory: remote.directory, state: waiting ? "needs_input" : entry.base, since: iso(now), detail: entry.detail ? `${entry.detail}; ${detail}` : detail }
  if (waiting) view.pending = entry.pending.map((p) => p.requestID)
  return view
}

class Hub implements DelegateHub {
  private readonly timers: Timers
  private readonly log: Logger
  private readonly api: OpencodeApi
  private readonly table: SessionTable
  private readonly buffer: EventBuffer
  private readonly memory = new MessageMemory()
  private readonly listeners = new Set<Listener>()
  private readonly cancels = new Set<() => void>()
  private stream: StreamControl | undefined
  private generation = 0
  private opened = false
  private queue: string[] | undefined
  private settle: (() => void) | undefined

  constructor(private readonly o: HubOptions) {
    this.timers = o.timers ?? realTimers
    this.log = o.log ?? silentLogger
    this.api = o.api ?? createApi(o.target, o.fetch)
    this.table = new SessionTable(() => this.timers.now(), o.notStartedMs ?? NOT_STARTED_MS)
    this.buffer = new EventBuffer(o.epoch ?? crypto.randomUUID(), this.timers, o.capacity)
  }

  /** Resolves once the first connection attempt settles (rebuilt, or failed and reported). */
  start(): Promise<void> {
    if (this.stream) return Promise.resolve()
    const first = new Promise<void>((resolve) => (this.settle = resolve))
    const handlers = { onOpen: () => this.onOpen(), onData: (d: string) => this.onData(d), onDrop: (d: Drop) => this.onDrop(d) }
    this.stream = runStream(this.o.target, handlers, { timers: this.timers, fetch: this.o.fetch, backoffMs: this.o.backoffMs, staleMs: this.o.staleMs })
    return first
  }

  async stop(): Promise<void> {
    const stream = this.stream
    this.stream = undefined
    this.generation++
    await stream?.stop()
    for (const cancel of this.cancels) cancel()
    this.cancels.clear()
    this.buffer.close()
    this.settled()
  }

  track(sessionID: string, directory: string): void {
    if (this.table.track(sessionID, directory)) safeLog(this.log, "debug", "events", "tracking session", { sessionID, directory })
  }

  markSent(sessionID: string): void {
    this.emitChanges(this.table.markSent(sessionID))
    if (!this.table.awaitingStart(sessionID)) return
    const cancel = this.timers.setTimeout(() => {
      this.cancels.delete(cancel)
      this.emitChanges(this.table.startTimeout(sessionID))
    }, this.o.notStartedMs ?? NOT_STARTED_MS)
    this.cancels.add(cancel)
  }

  async view(sessionID: string): Promise<SessionView> {
    const known = this.table.get(sessionID)
    if (known && TRUSTED.has(known.state)) return entryView(known)
    const detail = known ? `read from the server (hub state ${known.state})` : "read from the server"
    try {
      return remoteView(sessionID, await readRemote(this.api, sessionID, known?.directory), this.timers.now(), detail)
    } catch (error) {
      const code = isDelegateError(error) ? error.code : "upstream_error"
      safeLog(this.log, "warn", "events", "view could not read the server", { sessionID, code })
      return { sessionID, directory: known?.directory ?? "", state: code === "server_down" ? "server_down" : "unknown", since: iso(this.timers.now()), detail: code }
    }
  }

  events(cursor: Cursor | undefined, filter?: Filter, limit?: number): Page {
    return this.buffer.page(cursor, filter, limit)
  }

  wait(input: WaitInput): Promise<WaitResult> {
    return this.buffer.wait(input)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(input: HubEventInput): HubEvent {
    const event = this.buffer.append(input)
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

  private onOpen(): void {
    const gen = ++this.generation
    this.queue = []
    safeLog(this.log, "info", "events", "event stream connected; rebuilding state", { sessions: this.table.tracked().length })
    void this.rebuild(gen)
  }

  private async rebuild(gen: number): Promise<void> {
    let snapshot: Map<string, SnapshotEntry>
    try {
      snapshot = await readSnapshot(this.api, this.table.tracked())
    } catch (error) {
      if (gen !== this.generation) return
      const code = isDelegateError(error) ? error.code : "upstream_error"
      safeLog(this.log, "warn", "events", "state rebuild failed; reconnecting", { code, detail: isDelegateError(error) ? error.detail : undefined })
      this.queue = undefined
      this.stream?.restart()
      return
    }
    if (gen !== this.generation) return
    const reconnect = this.opened
    this.opened = true
    const changes = this.table.rebuild(snapshot)
    // The first connect only learns the starting state (view() shows it); it is not news.
    if (reconnect) {
      this.publish(resyncEvent(this.table.tracked().length))
      this.emitChanges(changes, "rebuild")
    }
    const queued = this.queue ?? []
    this.queue = undefined
    for (const data of queued) this.ingest(data)
    this.settled()
  }

  private onData(data: string): void {
    if (!this.queue) return this.ingest(data)
    this.queue.push(data)
    if (this.queue.length > MAX_QUEUED) {
      safeLog(this.log, "warn", "events", "too many events queued during rebuild; reconnecting")
      this.queue = undefined
      this.stream?.restart()
    }
  }

  private onDrop(drop: Drop): void {
    this.generation++
    this.queue = undefined
    const link = drop.kind === "unreachable" ? { kind: "down" as const, detail: `server unreachable (${drop.detail})` } : { kind: "gap" as const, detail: `${drop.kind}: ${drop.detail}` }
    safeLog(this.log, drop.kind === "unreachable" ? "warn" : "info", "events", "event stream dropped", { kind: drop.kind, detail: drop.detail })
    this.emitChanges(this.table.setLink(link), `stream ${drop.kind}`)
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
    const sessionID = sessionOf(raw)
    if (!sessionID) return
    if (!this.table.has(sessionID)) {
      if (!this.o.trackAll || !wrapper.directory) return
      this.table.track(sessionID, wrapper.directory)
    }
    this.apply(raw, sessionID)
  }

  private apply(raw: Raw, id: string): void {
    switch (raw.kind) {
      case "status":
        return this.emitChanges(this.table.status(id, raw.status, raw.attempt))
      case "error":
        this.table.error(id, raw.name, raw.aborted)
        return this.news(raw, id)
      case "permission.asked":
        this.table.ask(id, raw.requestID, "permission")
        return this.news(raw, id)
      case "question.asked":
        this.table.ask(id, raw.requestID, "question")
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

  private news(raw: Parameters<typeof rawEvent>[0], id: string): void {
    const e = this.table.get(id)
    if (e) this.publish(rawEvent(raw, { sessionID: id, directory: e.directory, state: e.state }))
  }
}

export function createHub(options: HubOptions): DelegateHub {
  return new Hub(options)
}
