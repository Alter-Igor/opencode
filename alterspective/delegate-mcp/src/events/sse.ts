// MOD-03 T3.1: SSE reader for the box's GET /global/event.
// createApi (shared/opencode-api.ts) is request/response only, so this module streams with fetch
// and the same basic-auth header. It parses SSE per the WHATWG rules the server uses (chunk
// boundaries, multi-line data, comments, CR/LF/CRLF), treats 30 s without any bytes as a dropped
// stream (the server sends a heartbeat every 10 s), and reconnects with backoff 1/2/5/10 s.
import type { ApiTarget } from "../shared/opencode-api.ts"
import { sleep, type Timers } from "./timers.ts"

export const EVENT_PATH = "/global/event"
export const BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000]
export const STALE_MS = 30_000
/** A line longer than this without a terminator is not SSE; drop it rather than grow forever. */
const MAX_PENDING = 8 * 1024 * 1024

export class SseParser {
  private pending = ""
  private data: string[] = []

  /** Feed decoded text; returns the `data` of every event completed by this chunk. */
  push(chunk: string): string[] {
    this.pending += chunk
    const out: string[] = []
    let start = 0
    for (let i = 0; i < this.pending.length; i++) {
      const c = this.pending[i]
      if (c !== "\n" && c !== "\r") continue
      // A CR at the very end may be the first half of a CRLF split across chunks: wait.
      if (c === "\r" && i === this.pending.length - 1) break
      const data = this.line(this.pending.slice(start, i))
      if (data !== undefined) out.push(data)
      if (c === "\r" && this.pending[i + 1] === "\n") i++
      start = i + 1
    }
    this.pending = this.pending.slice(start)
    if (this.pending.length > MAX_PENDING) this.pending = ""
    return out
  }

  private line(line: string): string | undefined {
    if (line === "") {
      const data = this.data.join("\n")
      this.data = []
      return data === "" ? undefined : data
    }
    if (line.startsWith(":")) return undefined // comment / keep-alive
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") this.data.push(value)
    return undefined // event, id, retry: not used by this server
  }
}

/** Why a stream attempt ended. `unreachable` = no HTTP answer at all (server down). */
export type Drop = { kind: "unreachable" | "http" | "closed" | "stale"; detail: string }

export type StreamHandlers = {
  onOpen(): void
  onData(data: string): void
  onDrop(drop: Drop): void
}

export type StreamOptions = {
  timers: Timers
  fetch?: typeof fetch
  backoffMs?: readonly number[]
  staleMs?: number
}

export type StreamControl = {
  /** Drop the current connection (the loop reconnects after backoff). */
  restart(): void
  stop(): Promise<void>
}

export function basicAuth(target: ApiTarget): string {
  return "Basic " + Buffer.from(`${target.username ?? "opencode"}:${target.password}`).toString("base64")
}

/** Name plus a short message: the URL has no credentials (auth rides in a header). */
function errorName(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message.slice(0, 120)}` : typeof error
}

type Dog = { fired: boolean; signal: AbortSignal; reader?: ReadableStreamDefaultReader<Uint8Array>; kick(): void; cancel(): void }

/**
 * No bytes for `ms` → abort. Any abort (watchdog, restart, stop) also cancels the reader, so a
 * silent socket can never hang the loop even if the runtime ignores the fetch signal mid-body.
 */
function watchdog(timers: Timers, ms: number, abort: AbortController): Dog {
  let cancel = () => {}
  const dog: Dog = {
    fired: false,
    signal: abort.signal,
    kick() {
      cancel()
      cancel = timers.setTimeout(() => {
        dog.fired = true
        abort.abort()
      }, ms)
    },
    cancel: () => cancel(),
  }
  abort.signal.addEventListener("abort", () => void dog.reader?.cancel().catch(() => undefined), { once: true })
  dog.kick()
  return dog
}

async function connect(target: ApiTarget, fetchImpl: typeof fetch, signal: AbortSignal): Promise<Response | Drop> {
  try {
    const url = new URL(EVENT_PATH, target.baseUrl)
    const res = await fetchImpl(url, { headers: { authorization: basicAuth(target), accept: "text/event-stream" }, signal })
    if (res.ok && res.body) return res
    await res.body?.cancel().catch(() => undefined)
    return { kind: "http", detail: `HTTP ${res.status}` }
  } catch (error) {
    return { kind: "unreachable", detail: errorName(error) }
  }
}

async function pump(body: ReadableStream<Uint8Array>, handlers: StreamHandlers, dog: Dog, staleMs: number): Promise<Drop> {
  const reader = body.getReader()
  dog.reader = reader
  if (dog.signal.aborted) void reader.cancel().catch(() => undefined)
  const decoder = new TextDecoder()
  const parser = new SseParser()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      dog.kick()
      for (const data of parser.push(decoder.decode(value, { stream: true }))) handlers.onData(data)
    }
  } catch (error) {
    if (!dog.fired) return { kind: "closed", detail: errorName(error) }
  }
  return dog.fired ? { kind: "stale", detail: `no data for ${staleMs} ms` } : { kind: "closed", detail: "stream ended" }
}

type Attempt = { drop: Drop; opened: boolean }

async function attempt(target: ApiTarget, o: Required<StreamOptions>, handlers: StreamHandlers, abort: AbortController): Promise<Attempt> {
  const dog = watchdog(o.timers, o.staleMs, abort)
  try {
    const res = await connect(target, o.fetch, abort.signal)
    if (!(res instanceof Response)) return { drop: dog.fired ? { kind: "unreachable", detail: "timeout" } : res, opened: false }
    dog.kick()
    handlers.onOpen()
    return { drop: await pump(res.body as ReadableStream<Uint8Array>, handlers, dog, o.staleMs), opened: true }
  } finally {
    dog.cancel()
  }
}

/** Keep one SSE connection alive until stop(). Every end of a connection is reported via onDrop. */
export function runStream(target: ApiTarget, handlers: StreamHandlers, options: StreamOptions): StreamControl {
  // Field by field: an explicit `undefined` from the caller must not erase a default.
  const o: Required<StreamOptions> = { timers: options.timers, fetch: options.fetch ?? fetch, backoffMs: options.backoffMs ?? BACKOFF_MS, staleMs: options.staleMs ?? STALE_MS }
  const stopper = new AbortController()
  let current: AbortController | undefined
  const loop = (async () => {
    let failures = 0
    while (!stopper.signal.aborted) {
      current = new AbortController()
      const result = await attempt(target, o, handlers, current)
      if (stopper.signal.aborted) return
      if (result.opened) failures = 0
      handlers.onDrop(result.drop)
      const delay = o.backoffMs[Math.min(failures, o.backoffMs.length - 1)] ?? 1000
      failures++
      await sleep(o.timers, delay, stopper.signal)
    }
  })()
  return {
    restart: () => current?.abort(),
    async stop() {
      stopper.abort()
      current?.abort()
      await loop
    },
  }
}
