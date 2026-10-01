// MOD-03 T3.1: SSE parsing per the WHATWG rules the server uses (chunk boundaries, multi-line
// data, comments, CR/LF/CRLF). Linear in the input (review W2A-17): each chunk is scanned once
// from where the last one ended, and a partial line is kept as pieces, never re-joined per chunk.
// Bounded (W2C-01): one event (its data lines plus the line in progress) may hold at most
// `maxEvent` characters. A bigger one is discarded up to the next blank line and reported through
// takeOverflow(), so the caller can treat it as a stream gap and rebuild state.

export const MAX_EVENT_CHARS = 1024 * 1024

export class SseParser {
  private parts: string[] = []
  private partChars = 0
  private lineEmpty = true
  private data: string[] = []
  private eventChars = 0
  private heldCR = false
  private discarding = false
  private overflowed = false

  constructor(private readonly maxEvent: number = MAX_EVENT_CHARS) {}

  /** Feed decoded text; returns the `data` of every event completed by this chunk. */
  push(chunk: string): string[] {
    const out: string[] = []
    let start = 0
    if (this.heldCR) {
      // The previous chunk ended in CR: that line ends now, and a leading LF is its CRLF partner.
      this.heldCR = false
      this.endLine(out)
      if (chunk.startsWith("\n")) start = 1
    }
    const terminator = /[\r\n]/g
    for (;;) {
      terminator.lastIndex = start
      const match = terminator.exec(chunk)
      if (!match) break
      const i = match.index
      this.addPart(chunk.slice(start, i))
      // A CR at the very end may be the first half of a CRLF split across chunks: hold it.
      if (chunk[i] === "\r" && i === chunk.length - 1) {
        this.heldCR = true
        return out
      }
      this.endLine(out)
      start = chunk[i] === "\r" && chunk[i + 1] === "\n" ? i + 2 : i + 1
    }
    this.addPart(chunk.slice(start))
    return out
  }

  /** True once after an oversized event was discarded. */
  takeOverflow(): boolean {
    const overflowed = this.overflowed
    this.overflowed = false
    return overflowed
  }

  /** Characters held for the event in progress (tests: memory stays bounded). */
  buffered(): number {
    return this.partChars + this.eventChars
  }

  private addPart(text: string): void {
    if (text.length === 0) return
    this.lineEmpty = false
    if (this.discarding) return
    this.parts.push(text)
    this.partChars += text.length
    if (this.partChars + this.eventChars > this.maxEvent) this.overflow()
  }

  private overflow(): void {
    this.discarding = true
    this.overflowed = true
    this.parts = []
    this.partChars = 0
    this.data = []
    this.eventChars = 0
  }

  private endLine(out: string[]): void {
    const empty = this.lineEmpty
    const line = this.parts.length === 1 ? (this.parts[0] ?? "") : this.parts.join("")
    this.parts = []
    this.partChars = 0
    this.lineEmpty = true
    if (this.discarding) {
      if (empty) this.discarding = false // the oversized event ended here
      return
    }
    const data = this.line(line)
    if (data !== undefined) out.push(data)
  }

  private line(line: string): string | undefined {
    if (line === "") {
      const data = this.data.join("\n")
      this.data = []
      this.eventChars = 0
      return data === "" ? undefined : data
    }
    if (line.startsWith(":")) return undefined // comment / keep-alive
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") {
      this.data.push(value)
      this.eventChars += value.length + 1
    }
    return undefined // event, id, retry: not used by this server
  }
}
