// MOD-03 T3.1: SSE reader for the box's GET /global/event.
// createApi (shared/opencode-api.ts) is request/response only, so this module streams with fetch
// and the same basic-auth header. Parsing is in sse-parser.ts. 30 s without any bytes is a
// dropped stream (the server sends a heartbeat every 10 s); reconnects back off 1/2/5/10 s, and
// the backoff only resets once a connection proved healthy — the hub rebuilt state on it, or it
// stayed up for HEALTHY_MS (W2A-09) — so a server that accepts and then fails cannot make the
// loop spin. Redirects are refused (W2C-02): the bridge only ever talks to the box it was given.
import { isRedirectError, type ApiTarget } from "../shared/opencode-api.ts"
import { SseParser } from "./sse-parser.ts"
import { sleep, type Timers } from "./timers.ts"

export { MAX_EVENT_CHARS, SseParser } from "./sse-parser.ts"

export const EVENT_PATH = "/global/event"
export const BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000]
export const STALE_MS = 30_000
/** A connection that stayed up this long resets the backoff even without a rebuild. */
export const HEALTHY_MS = 60_000

/** Why a stream attempt ended. `unreachable` = no HTTP answer at all (server down). */
export type Drop = { kind: "unreachable" | "http" | "closed" | "stale"; detail: string }

export type StreamHandlers = {
  onOpen(): void
  onData(data: string): void
  onDrop(drop: Drop): void
  /** Events were lost inside a live stream (an oversized event was discarded): rebuild state. */
  onGap?(detail: string): void
}

export type StreamOptions = {
  timers: Timers
  fetch?: typeof fetch
  backoffMs?: readonly number[]
  staleMs?: number
  healthyMs?: number
}

export type StreamControl = {
  /** Drop the current connection (the loop reconnects after backoff). */
  restart(): void
  /** The current connection is good (state rebuilt on it): the next drop starts the backoff over. */
  healthy(): void
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
    const res = await fetchImpl(url, { headers: { authorization: basicAuth(target), accept: "text/event-stream" }, signal, redirect: "error" })
    if (res.ok && res.body) return res
    await res.body?.cancel().catch(() => undefined)
    const redirect = res.status >= 300 && res.status < 400 ? "redirect refused, " : ""
    return { kind: "http", detail: `${redirect}HTTP ${res.status}` }
  } catch (error) {
    if (isRedirectError(error)) return { kind: "http", detail: "redirect refused" }
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
      if (parser.takeOverflow()) handlers.onGap?.("an event over 1 MB was discarded")
    }
  } catch (error) {
    if (!dog.fired) return { kind: "closed", detail: errorName(error) }
  }
  return dog.fired ? { kind: "stale", detail: `no data for ${staleMs} ms` } : { kind: "closed", detail: "stream ended" }
}

type Attempt = { drop: Drop; openedAt?: number }

async function attempt(target: ApiTarget, o: Required<StreamOptions>, handlers: StreamHandlers, abort: AbortController): Promise<Attempt> {
  const dog = watchdog(o.timers, o.staleMs, abort)
  try {
    const res = await connect(target, o.fetch, abort.signal)
    if (!(res instanceof Response)) return { drop: dog.fired ? { kind: "unreachable", detail: "timeout" } : res }
    dog.kick()
    const openedAt = o.timers.now()
    handlers.onOpen()
    return { drop: await pump(res.body as ReadableStream<Uint8Array>, handlers, dog, o.staleMs), openedAt }
  } finally {
    dog.cancel()
  }
}

/** Keep one SSE connection alive until stop(). Every end of a connection is reported via onDrop. */
export function runStream(target: ApiTarget, handlers: StreamHandlers, options: StreamOptions): StreamControl {
  // Field by field: an explicit `undefined` from the caller must not erase a default.
  const o: Required<StreamOptions> = { timers: options.timers, fetch: options.fetch ?? fetch, backoffMs: options.backoffMs ?? BACKOFF_MS, staleMs: options.staleMs ?? STALE_MS, healthyMs: options.healthyMs ?? HEALTHY_MS }
  const stopper = new AbortController()
  let current: AbortController | undefined
  let healthy = false
  const loop = (async () => {
    let failures = 0
    while (!stopper.signal.aborted) {
      current = new AbortController()
      healthy = false
      const result = await attempt(target, o, handlers, current)
      if (stopper.signal.aborted) return
      const lasted = result.openedAt !== undefined && o.timers.now() - result.openedAt >= o.healthyMs
      if (healthy || lasted) failures = 0
      handlers.onDrop(result.drop)
      const delay = o.backoffMs[Math.min(failures, o.backoffMs.length - 1)] ?? 1000
      failures++
      await sleep(o.timers, delay, stopper.signal)
    }
  })()
  return {
    restart: () => current?.abort(),
    healthy: () => void (healthy = true),
    async stop() {
      stopper.abort()
      current?.abort()
      await loop
    },
  }
}
