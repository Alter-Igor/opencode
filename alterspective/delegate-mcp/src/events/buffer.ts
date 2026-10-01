// MOD-03: the cursor buffer. A ring of the last 5,000 hub events; a cursor is {epoch, seq} where
// the epoch is random per hub start, so a cursor from an earlier bridge run is recognised as
// expired instead of silently pointing at different events.
import type { Cursor, HubEvent, SessionState, SessionView, WaitUntil } from "../shared/contracts.ts"
import { DelegateError } from "../shared/errors.ts"
import type { Timers } from "./timers.ts"

export const CAPACITY = 5000
export const DEFAULT_PAGE = 100
export const MAX_PAGE = 200

export type HubEventInput = Omit<HubEvent, "cursor" | "at">
export type Filter = { sessionID?: string }
export type Page = { events: HubEvent[]; next: Cursor; expired: boolean }
export type WaitInput = { sessionIDs: string[]; until: WaitUntil[]; timeoutMs: number; cursor?: Cursor }
/** `views`: sessions found already in a matching state by reading state, not by an event (W2A-05/06). */
export type WaitResult = { events: HubEvent[]; next: Cursor; timedOut: boolean; views?: SessionView[] }

/** `until: idle` means the run is over, however it ended (W2A-05). */
const SETTLED_STATES = new Set<SessionState>(["idle", "error", "aborted", "not_started", "not_found"])
const ERROR_STATES = new Set<SessionState>(["error", "aborted", "not_started", "not_found", "server_down"])

function stateMatches(state: SessionState | undefined, until: WaitUntil): boolean {
  if (state === undefined) return false
  if (until === "idle") return SETTLED_STATES.has(state)
  if (until === "error") return ERROR_STATES.has(state)
  return false
}

/** The `until` mapping (oc_wait): idle → settled; needs_input → permission/question asked; error → failure states; message → reply or inbox. */
export function matchesUntil(event: HubEvent, until: WaitUntil): boolean {
  if (until === "needs_input") return event.type === "permission" || event.type === "question"
  if (until === "message") return event.type === "message" || event.type === "inbox"
  // Only status events carry the session's settled state; an error event's state is the state at the time.
  return event.type === "status" && stateMatches(event.state, until)
}

/** The same mapping against a current view (no event): needs_input is the state itself. */
export function viewMatches(view: SessionView, until: WaitUntil): boolean {
  if (until === "needs_input") return view.state === "needs_input"
  return stateMatches(view.state, until)
}

/**
 * Session filter for wait(): events without a session (inbox to the supervisor) always pass; a
 * subagent's permission/question also passes for its parent (W2A-03).
 */
function matchesWait(event: HubEvent, input: WaitInput): boolean {
  const ids = input.sessionIDs
  const asks = event.type === "permission" || event.type === "question"
  const sessionOk = ids.length === 0 || event.sessionID === undefined || ids.includes(event.sessionID) || (asks && event.parentID !== undefined && ids.includes(event.parentID))
  return sessionOk && input.until.some((u) => matchesUntil(event, u))
}

type Waiter = { input: WaitInput; resolve(result: WaitResult): void; cancel(): void }

export class EventBuffer {
  private readonly ring: HubEvent[] = []
  private seq = 0
  private readonly waiters = new Set<Waiter>()

  constructor(
    readonly epoch: string,
    private readonly timers: Timers,
    private readonly capacity: number = CAPACITY,
  ) {}

  head(): Cursor {
    return { epoch: this.epoch, seq: this.seq }
  }

  append(input: HubEventInput): HubEvent {
    this.seq++
    const event: HubEvent = { ...input, cursor: { epoch: this.epoch, seq: this.seq }, at: new Date(this.timers.now()).toISOString() }
    this.ring.push(event)
    if (this.ring.length > this.capacity) this.ring.shift()
    for (const w of [...this.waiters]) {
      if (!matchesWait(event, w.input)) continue
      this.waiters.delete(w)
      w.cancel()
      w.resolve({ events: [event], next: event.cursor, timedOut: false })
    }
    return event
  }

  /** Events with seq > `after` still in the ring, or undefined when some were already dropped. */
  private after(after: number): HubEvent[] | undefined {
    const first = this.ring[0]?.cursor.seq ?? this.seq + 1
    if (after < first - 1) return undefined
    return this.ring.slice(Math.max(0, after - first + 1))
  }

  page(cursor: Cursor | undefined, filter: Filter = {}, limit: number = DEFAULT_PAGE): Page {
    const size = Math.max(1, Math.min(MAX_PAGE, Math.floor(limit)))
    if (cursor && cursor.epoch !== this.epoch) return { events: [], next: this.head(), expired: true }
    const from = cursor ? Math.min(cursor.seq, this.seq) : (this.ring[0]?.cursor.seq ?? this.seq + 1) - 1
    const rest = this.after(from)
    if (!rest) return { events: [], next: this.head(), expired: true }
    const events: HubEvent[] = []
    let next: Cursor = { epoch: this.epoch, seq: from }
    for (const event of rest) {
      if (events.length >= size) break
      next = event.cursor
      if (!filter.sessionID || event.sessionID === filter.sessionID) events.push(event)
    }
    return { events, next, expired: false }
  }

  /**
   * First matching events after `cursor` (or from now), else long-poll until one arrives or the
   * timeout. A foreign-epoch or overrun cursor throws cursor_expired: the caller must resync.
   */
  wait(input: WaitInput): Promise<WaitResult> {
    const cursor = input.cursor
    if (cursor && cursor.epoch !== this.epoch) return Promise.reject(expired())
    const rest = cursor ? this.after(Math.min(cursor.seq, this.seq)) : []
    if (!rest) return Promise.reject(expired())
    const hits = rest.filter((e) => matchesWait(e, input)).slice(0, MAX_PAGE)
    const last = hits[hits.length - 1]
    if (last) return Promise.resolve({ events: hits, next: hits.length === MAX_PAGE ? last.cursor : this.head(), timedOut: false })
    return new Promise((resolve) => {
      const waiter: Waiter = { input, resolve, cancel: () => {} }
      waiter.cancel = this.timers.setTimeout(() => {
        this.waiters.delete(waiter)
        resolve({ events: [], next: this.head(), timedOut: true })
      }, Math.max(0, input.timeoutMs))
      this.waiters.add(waiter)
    })
  }

  /** Resolve every pending wait as timed out (hub stop). */
  close(): void {
    for (const w of this.waiters) {
      w.cancel()
      w.resolve({ events: [], next: this.head(), timedOut: true })
    }
    this.waiters.clear()
  }
}

function expired(): DelegateError {
  return new DelegateError("cursor_expired", "The event cursor is from an earlier bridge run or too old.", "Call oc_status for current state, then oc_events without a cursor.")
}
