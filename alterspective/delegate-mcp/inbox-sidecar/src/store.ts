// FEAT-OCD-001 MOD-05: append-only message store (technical-design.md §7, review G5).
// Messages are JSON lines in segment files under the data volume. Every append is written and
// fsync'd before the caller gets an answer. There is no update or delete operation: the only
// thing that ever removes data is retention, which drops the oldest whole segment once more
// than `maxSegments` exist. Ids are a monotonic counter and double as read cursors.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from "node:fs"
import path from "node:path"
import type { StoredMessage } from "./rules.ts"

export type StoreOptions = {
  dir: string
  /** Start a new segment once the current one reaches this size. Default 10 MB. */
  segmentBytes?: number
  /** Oldest segments beyond this count are deleted on rotation. Default 5. */
  maxSegments?: number
}

/** `torn`: the file does not end in a newline (a write cut short), so the next append starts one. */
type Segment = { file: string; firstSeq: number; lastSeq: number; bytes: number; torn: boolean }

const SEGMENT = /^inbox-(\d{12})\.jsonl$/
const DEFAULT_SEGMENT_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_SEGMENTS = 5

export type NewMessage = Omit<StoredMessage, "id">

export type Page = { messages: StoredMessage[]; next: string }

export class InboxStore {
  readonly #dir: string
  readonly #segmentBytes: number
  readonly #maxSegments: number
  readonly #segments: Segment[] = []
  readonly #byAddress = new Map<string, StoredMessage[]>()
  readonly #threadHops = new Map<string, number>()
  #seq = 0
  #fd: number | undefined
  /** Lines that could not be parsed when the store was opened (e.g. a torn last write). */
  skippedLines = 0

  private constructor(options: StoreOptions) {
    this.#dir = options.dir
    this.#segmentBytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES
    this.#maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS
  }

  /** Open (or create) the store and load every segment on disk. */
  static open(options: StoreOptions): InboxStore {
    const store = new InboxStore(options)
    mkdirSync(options.dir, { recursive: true })
    const names = readdirSync(options.dir).filter((name) => SEGMENT.test(name)).sort()
    for (const name of names) store.#load(name)
    return store
  }

  get lastId(): number {
    return this.#seq
  }

  #load(name: string): void {
    const file = path.join(this.#dir, name)
    const text = readFileSync(file, "utf8")
    const firstSeq = Number(SEGMENT.exec(name)![1])
    const segment: Segment = { file, firstSeq, lastSeq: firstSeq - 1, bytes: statSync(file).size, torn: text.length > 0 && !text.endsWith("\n") }
    for (const line of text.split("\n")) {
      if (!line) continue
      const message = parseLine(line)
      if (!message) {
        this.skippedLines++
        continue
      }
      this.#index(message)
      segment.lastSeq = Math.max(segment.lastSeq, Number(message.id))
    }
    this.#segments.push(segment)
  }

  #index(message: StoredMessage): void {
    const seq = Number(message.id)
    this.#seq = Math.max(this.#seq, seq)
    const list = this.#byAddress.get(message.to) ?? []
    list.push(message)
    this.#byAddress.set(message.to, list)
    if (message.correlationId) this.#threadHops.set(message.correlationId, Math.max(this.#threadHops.get(message.correlationId) ?? 0, message.hops))
  }

  /** Highest hop count stored for a thread, or undefined for a new thread. */
  threadHops(correlationId: string): number | undefined {
    return this.#threadHops.get(correlationId)
  }

  /** Append one message: assigns the id, writes the line and fsyncs before returning. */
  append(input: NewMessage): StoredMessage {
    const message: StoredMessage = { id: String(this.#seq + 1), ...input }
    const record = JSON.stringify(message) + "\n"
    const segment = this.#segmentFor(Buffer.byteLength(record), this.#seq + 1)
    const line = segment.torn ? "\n" + record : record
    const fd = this.#fd!
    writeSync(fd, line)
    fsyncSync(fd)
    segment.torn = false
    segment.bytes += Buffer.byteLength(line)
    segment.lastSeq = Number(message.id)
    this.#index(message)
    return message
  }

  #segmentFor(lineBytes: number, seq: number): Segment {
    const current = this.#segments.at(-1)
    const full = current !== undefined && current.bytes > 0 && current.bytes + lineBytes > this.#segmentBytes
    if (current && !full) {
      if (this.#fd === undefined) this.#fd = openSync(current.file, "a")
      return current
    }
    if (this.#fd !== undefined) closeSync(this.#fd)
    const segment = this.#newSegment(seq)
    this.#fd = openSync(segment.file, "a")
    return segment
  }

  #newSegment(seq: number): Segment {
    const file = path.join(this.#dir, `inbox-${String(seq).padStart(12, "0")}.jsonl`)
    const segment: Segment = { file, firstSeq: seq, lastSeq: seq - 1, bytes: 0, torn: false }
    this.#segments.push(segment)
    while (this.#segments.length > this.#maxSegments) this.#dropOldest()
    return segment
  }

  /** Retention only (never reachable from a route): remove the oldest segment file and its messages. */
  #dropOldest(): void {
    const oldest = this.#segments.shift()!
    rmSync(oldest.file, { force: true })
    for (const [address, list] of this.#byAddress) {
      const kept = list.filter((message) => Number(message.id) > oldest.lastSeq)
      if (kept.length) this.#byAddress.set(address, kept)
      else this.#byAddress.delete(address)
    }
  }

  /** Messages to `address` with id > cursor, oldest first. `next` is the cursor for the next page. */
  read(address: string, cursor: number, limit: number): Page {
    const list = this.#byAddress.get(address) ?? []
    const messages = list.filter((message) => Number(message.id) > cursor).slice(0, limit)
    const last = messages.at(-1)
    return { messages: messages.map((message) => ({ ...message })), next: last ? last.id : String(cursor) }
  }

  close(): void {
    if (this.#fd !== undefined) closeSync(this.#fd)
    this.#fd = undefined
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
