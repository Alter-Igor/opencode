// FEAT-OCD-001 MOD-05: append-only message store (technical-design.md §7, review G5).
// Messages are JSON lines in two segment series under the data volume (segments.ts):
//   inbox-*.jsonl  messages to session inboxes (and any written before the split)
//   sup-*.jsonl    messages to supervisor inboxes
// Each series has its own retention budget, so session-to-session traffic can never evict an
// unread message to a supervisor (W2C-08). There is no update or delete operation: retention is
// the only thing that ever removes data. Ids are one monotonic counter and double as read cursors.
// `state.json` holds the store's epoch (random per data volume, so a cursor from a wiped volume
// is caught) and, per series, the highest id retention has dropped (so a reader learns its cursor
// fell into a gap).
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { EPOCH, SUPERVISOR_ADDRESS, type StoredMessage } from "./rules.ts"
import { SegmentLog } from "./segments.ts"

export type StoreOptions = {
  dir: string
  /** Start a new segment once the current one reaches this size. Default 10 MB. */
  segmentBytes?: number
  /** Oldest session-inbox segments beyond this count are deleted on rotation. Default 5. */
  maxSegments?: number
  /** Retention budget of the supervisor-inbox series. Defaults to the values above. */
  supervisor?: { segmentBytes?: number; maxSegments?: number }
}

type Series = "session" | "supervisor"
const SERIES: readonly Series[] = ["session", "supervisor"]
const PREFIX: Record<Series, string> = { session: "inbox", supervisor: "sup" }
const DEFAULT_SEGMENT_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_SEGMENTS = 5
const STATE_FILE = "state.json"

export type NewMessage = Omit<StoredMessage, "id">

/**
 * One read. `oldestId`: every id below it in this inbox's series was dropped by retention (or
 * never existed), so a cursor below `oldestId - 1` may have missed messages. `lastId`: the
 * highest id ever stored; a cursor above it did not come from this store.
 */
export type Page = { messages: StoredMessage[]; next: string; epoch: string; oldestId: string; lastId: string }

/** Per thread: highest hop index, how many verified (supervisor) posts, and where the last one lives. */
export type ThreadState = { hops: number; verifiedCount: number; lastSeq: number; series: Series }

type State = { epoch: string; evicted: Record<Series, number> }

export function seriesOf(address: string): Series {
  return SUPERVISOR_ADDRESS.test(address) ? "supervisor" : "session"
}

export class InboxStore {
  readonly #dir: string
  readonly #logs: Record<Series, SegmentLog>
  readonly #index: Record<Series, Map<string, StoredMessage[]>> = { session: new Map(), supervisor: new Map() }
  readonly #threads = new Map<string, ThreadState>()
  #state: State = { epoch: "", evicted: { session: 0, supervisor: 0 } }
  #seq = 0
  /** Lines that could not be parsed when the store was opened (e.g. a torn last write). */
  skippedLines = 0
  /** True when state.json was missing or unreadable and a new epoch was made (old cursors expire). */
  newEpoch = false

  private constructor(options: StoreOptions) {
    this.#dir = options.dir
    const bytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES
    const max = options.maxSegments ?? DEFAULT_MAX_SEGMENTS
    const sup = { segmentBytes: options.supervisor?.segmentBytes ?? bytes, maxSegments: options.supervisor?.maxSegments ?? max }
    this.#logs = {
      session: new SegmentLog({ dir: options.dir, prefix: PREFIX.session, segmentBytes: bytes, maxSegments: max }, (through) => this.#evict("session", through)),
      supervisor: new SegmentLog({ dir: options.dir, prefix: PREFIX.supervisor, ...sup }, (through) => this.#evict("supervisor", through)),
    }
  }

  /** Open (or create) the store and load every segment on disk. */
  static open(options: StoreOptions): InboxStore {
    const store = new InboxStore(options)
    mkdirSync(options.dir, { recursive: true })
    store.#loadState()
    for (const series of SERIES) store.#logs[series].load((line) => store.#loadLine(line, series))
    return store
  }

  get lastId(): number {
    return this.#seq
  }

  get epoch(): string {
    return this.#state.epoch
  }

  #loadState(): void {
    try {
      const raw = JSON.parse(readFileSync(path.join(this.#dir, STATE_FILE), "utf8")) as Partial<State>
      const evicted = raw.evicted as Partial<Record<Series, unknown>> | undefined
      if (typeof raw.epoch === "string" && EPOCH.test(raw.epoch) && typeof evicted?.session === "number" && typeof evicted.supervisor === "number") {
        this.#state = { epoch: raw.epoch, evicted: { session: evicted.session, supervisor: evicted.supervisor } }
        return
      }
    } catch {
      // missing or unreadable: start a new epoch below
    }
    this.newEpoch = true
    this.#state = { epoch: randomBytes(8).toString("hex"), evicted: { session: 0, supervisor: 0 } }
    this.#saveState()
  }

  /** Write state.json atomically (temp file, fsync, rename). */
  #saveState(): void {
    const file = path.join(this.#dir, STATE_FILE)
    const temp = `${file}.tmp`
    const fd = openSync(temp, "w")
    try {
      writeSync(fd, JSON.stringify(this.#state))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
  }

  #loadLine(line: string, series: Series): number | undefined {
    const message = parseLine(line)
    if (!message) {
      this.skippedLines++
      return undefined
    }
    this.#indexMessage(message, series)
    return Number(message.id)
  }

  #indexMessage(message: StoredMessage, series: Series): void {
    const seq = Number(message.id)
    this.#seq = Math.max(this.#seq, seq)
    const index = this.#index[series]
    const list = index.get(message.to) ?? []
    list.push(message)
    index.set(message.to, list)
    if (!message.correlationId) return
    const prior = this.#threads.get(message.correlationId)
    this.#threads.set(message.correlationId, {
      hops: Math.max(prior?.hops ?? 0, message.hops),
      verifiedCount: (prior?.verifiedCount ?? 0) + (message.verified ? 1 : 0),
      lastSeq: Math.max(prior?.lastSeq ?? 0, seq),
      series: seq >= (prior?.lastSeq ?? 0) ? series : prior!.series,
    })
  }

  /** What the store knows about a thread, or undefined for a new (or fully expired) thread. */
  thread(correlationId: string): Readonly<ThreadState> | undefined {
    return this.#threads.get(correlationId)
  }

  /** Threads tracked in memory (pruned together with retention, W2C-11). */
  get threadCount(): number {
    return this.#threads.size
  }

  /** Append one message: assigns the id, writes the line and fsyncs before returning. */
  append(input: NewMessage): StoredMessage {
    const message: StoredMessage = { id: String(this.#seq + 1), ...input }
    const series = seriesOf(message.to)
    this.#logs[series].append(message)
    this.#indexMessage(message, series)
    return message
  }

  /** Forget messages and threads retention dropped from `series` (ids <= through), then persist it. */
  #evict(series: Series, through: number): void {
    const index = this.#index[series]
    for (const [address, list] of index) {
      const kept = list.filter((message) => Number(message.id) > through)
      if (kept.length) index.set(address, kept)
      else index.delete(address)
    }
    for (const [id, thread] of this.#threads) if (thread.series === series && thread.lastSeq <= through) this.#threads.delete(id)
    this.#state.evicted[series] = Math.max(this.#state.evicted[series], through)
    this.#saveState()
  }

  /** Messages to `address` with id > cursor, oldest first. `next` is the cursor for the next page. */
  read(address: string, cursor: number, limit: number): Page {
    const series = seriesOf(address)
    const other = this.#index[series === "session" ? "supervisor" : "session"].get(address)
    const own = this.#index[series].get(address) ?? []
    const list = other ? [...other, ...own].sort((a, b) => Number(a.id) - Number(b.id)) : own
    const messages = list.filter((message) => Number(message.id) > cursor).slice(0, limit)
    const last = messages.at(-1)
    return {
      messages: messages.map((message) => ({ ...message })),
      next: last ? last.id : String(cursor),
      epoch: this.#state.epoch,
      oldestId: String(this.#state.evicted[series] + 1),
      lastId: String(this.#seq),
    }
  }

  close(): void {
    for (const series of SERIES) this.#logs[series].close()
  }
}

function parseLine(line: string): StoredMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const m = value as Record<string, unknown>
  const ok =
    typeof m.id === "string" && /^\d+$/.test(m.id) && typeof m.at === "string" && typeof m.from === "string" &&
    typeof m.to === "string" && typeof m.text === "string" && typeof m.hops === "number" && typeof m.verified === "boolean" &&
    (m.correlationId === undefined || typeof m.correlationId === "string")
  return ok ? (m as StoredMessage) : undefined
}
