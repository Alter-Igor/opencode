// FEAT-OCD-001 MOD-05: one append-only series of JSONL segment files (`<prefix>-<firstSeq>.jsonl`).
// Every append is written in full and fsync'd before it returns. Retention is the only thing
// that removes data: once more than `maxSegments` files exist, the oldest whole file is dropped.
import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeSync } from "node:fs"
import path from "node:path"
import type { StoredMessage } from "./rules.ts"

/** `torn`: the file does not end in a newline (a write cut short), so the next append starts one. */
type Segment = { file: string; firstSeq: number; lastSeq: number; bytes: number; torn: boolean }

export type SeriesOptions = { dir: string; prefix: string; segmentBytes: number; maxSegments: number }

const NEWLINE = 0x0a

export class SegmentLog {
  readonly #options: SeriesOptions
  readonly #onDrop: (through: number) => void
  readonly #pattern: RegExp
  readonly #segments: Segment[] = []
  #fd: number | undefined

  /** `onDrop(through)` runs when retention removes a file, with the highest id that file held. */
  constructor(options: SeriesOptions, onDrop: (through: number) => void) {
    this.#options = options
    this.#onDrop = onDrop
    this.#pattern = new RegExp(`^${options.prefix}-(\\d{12})\\.jsonl$`)
  }

  /** Read every segment of this series; `onLine` gets each non-empty line, and returns its id when it parsed. */
  load(onLine: (line: string) => number | undefined): void {
    const names = readdirSync(this.#options.dir).filter((name) => this.#pattern.test(name)).sort()
    for (const name of names) {
      const file = path.join(this.#options.dir, name)
      const text = readFileSync(file, "utf8")
      const firstSeq = Number(this.#pattern.exec(name)![1])
      const segment: Segment = { file, firstSeq, lastSeq: firstSeq - 1, bytes: statSync(file).size, torn: text.length > 0 && !text.endsWith("\n") }
      for (const line of text.split("\n")) {
        if (!line) continue
        const id = onLine(line)
        if (id !== undefined) segment.lastSeq = Math.max(segment.lastSeq, id)
      }
      this.#segments.push(segment)
    }
  }

  /** Append one message line. On a failed or short write the segment is marked torn (W2C-15) and the error is rethrown. */
  append(message: StoredMessage): void {
    const record = JSON.stringify(message) + "\n"
    const segment = this.#segmentFor(Buffer.byteLength(record), Number(message.id))
    const line = Buffer.from(segment.torn ? "\n" + record : record, "utf8")
    const fd = this.#fd!
    try {
      writeAll(fd, line)
      fsyncSync(fd)
    } catch (error) {
      segment.torn = true
      segment.bytes = safeSize(fd, segment.bytes)
      throw error
    }
    segment.torn = false
    segment.bytes += line.length
    segment.lastSeq = Number(message.id)
  }

  #segmentFor(lineBytes: number, seq: number): Segment {
    const current = this.#segments.at(-1)
    const full = current !== undefined && current.bytes > 0 && current.bytes + lineBytes > this.#options.segmentBytes
    if (current && !full) {
      if (this.#fd === undefined) this.#fd = openChecked(current)
      return current
    }
    this.close()
    const file = path.join(this.#options.dir, `${this.#options.prefix}-${String(seq).padStart(12, "0")}.jsonl`)
    const segment: Segment = { file, firstSeq: seq, lastSeq: seq - 1, bytes: 0, torn: false }
    this.#segments.push(segment)
    while (this.#segments.length > this.#options.maxSegments) this.#dropOldest()
    this.#fd = openChecked(segment)
    return segment
  }

  /** Retention only (never reachable from a route): remove the oldest file and report it. */
  #dropOldest(): void {
    const oldest = this.#segments.shift()!
    rmSync(oldest.file, { force: true })
    this.#onDrop(oldest.lastSeq)
  }

  close(): void {
    if (this.#fd !== undefined) closeSync(this.#fd)
    this.#fd = undefined
  }
}

/** Open a segment for appending and re-check its real size and last byte (W2C-15). */
function openChecked(segment: Segment): number {
  const fd = openSync(segment.file, "a+")
  const size = fstatSync(fd).size
  segment.bytes = size
  if (size > 0) {
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    segment.torn = last[0] !== NEWLINE
  }
  return fd
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset)
    if (written <= 0) throw new Error("short write")
    offset += written
  }
}

function safeSize(fd: number, fallback: number): number {
  try {
    return fstatSync(fd).size
  } catch {
    return fallback
  }
}
