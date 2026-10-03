// #80: when a pinned Synapse model cannot serve a request (out of credit or budget, no tool
// support, not found or unavailable, rate limited), resend the same body ONCE with `auto`.
// Core retry would otherwise repeat the same failing model up to 5 times.
//
// Never for auth (401/403), and never for context or validation errors that `auto` would also
// hit. The caller resends with the same headers, so `x-privacy-tier: local-only` stays on the
// request and `auto` stays local-only. Only the status and the error body are read, never the
// prompt. The decision is made from the status and a clone of the error body, before the
// caller consumes anything.

export const PINNED_FALLBACK_ENV = "OPENCODE_SYNAPSE_PINNED_FALLBACK"
export const SYNAPSE_AUTO_ROUTE = "auto"

export type PinnedFallbackReason = "budget" | "no-tool-support" | "model-unavailable" | "rate-limited"

/** What the FALLBACK_TRIGGERED diagnostic records. No token, no message text. */
export interface PinnedFallbackEvent {
  originalModel: string
  reason: PinnedFallbackReason
  status: number
  fallbackModel: typeof SYNAPSE_AUTO_ROUTE
  fallbackStatus: number
  servedModel?: string
  localOnly: boolean
  /** True when the failure came as the first event of an HTTP 200 stream. */
  inStream?: boolean
}

/** On unless OPENCODE_SYNAPSE_PINNED_FALLBACK is 0, false, off or no. */
export function pinnedFallbackEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[PINNED_FALLBACK_ENV]?.trim().toLowerCase()
  return !(value === "0" || value === "false" || value === "off" || value === "no")
}

/** A model the caller chose, as opposed to Synapse's own routing (`auto`). */
export function isPinnedModel(model: unknown): model is string {
  if (typeof model !== "string") return false
  const id = model.trim().toLowerCase()
  return id !== "" && id !== SYNAPSE_AUTO_ROUTE && id !== `synapse/${SYNAPSE_AUTO_ROUTE}`
}

const CONTEXT_OR_VALIDATION =
  /context_length_exceeded|context[ _]window|maximum context|too many tokens|prompt is too long|context_overflow/i

/** Codes that always mean the model's credit or budget is spent. */
const BUDGET_CODE = /budget_exhausted|insufficient_quota/i
/** Words that mean "out of credit" only next to a 402, a budget code or availability wording. */
const BUDGET_WORDS = /\b(credit|insufficient|balance)\b/i
/** Wording that says the model (not the request) is unavailable. */
const AVAILABILITY = /not available|unavailable|no (eligible|available|healthy) (provider|endpoint|rung)s?/i
/**
 * A 404 that points at the model, not at the route. "model ... not found" must say "model" within
 * a short span, and a body that talks about a route or path is never read as a missing model:
 * a typo in the URL must not send every request to `auto`.
 */
const MODEL_MISSING = /no endpoints found|model_not_found|model_unavailable|\bmodel\b[^\n]{0,60}\bnot found\b|\brungs?\b/i
const ROUTE_MISSING = /\b(route|path|url)\b|cannot (get|post|put)\b/i
/**
 * The model cannot take tool calls. Synapse #1815 answers 404 `model_not_available` with "No
 * available model can serve this request's required capability: tool calling ... or send the
 * request without tools". Its wording may still change, so either phrase matches.
 */
const NO_TOOL_SUPPORT =
  /no endpoints found that support tool use|does not support (tools|tool use|function calling)|required capability:\s*tool calling|without tools/i
/**
 * Synapse's model-missing replies: 404 `model_not_available` ("No available instance serves
 * model ...", "Model ... is not available to this caller") without the tool wording above.
 */
const MODEL_NOT_AVAILABLE_CODES = new Set(["model_not_found", "model_unavailable", "model_not_available"])
/** Message wording that names the model as unavailable; any other text mentioning the codes does not count. */
const MODEL_NOT_AVAILABLE_TEXT = /no available instance serves model/i

/**
 * The structured error code of an error body: `error.code` or a top-level `code`. A body that
 * is not JSON (an MCP tool error string) is searched for a `"code": "..."` pair instead.
 */
export function errorCodeOf(body: string): string | undefined {
  try {
    const value: any = JSON.parse(body)
    const code = value?.error?.code ?? value?.code
    return typeof code === "string" ? code : undefined
  } catch {
    return /"code"\s*:\s*"([A-Za-z0-9_.-]+)"/.exec(body)?.[1]
  }
}
/**
 * The caller declined model substitution (Synapse authorization-guard: "This request declined
 * model substitution, so ... could not be served by ..."). Falling back to `auto` would override
 * that choice, so it never falls back.
 */
const SUBSTITUTION_DECLINED = /declined model substitution/i

/** The same JSON body with `model: "auto"`; every other field is kept. Undefined when it is not a JSON object. */
export function withAutoModel(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined
  try {
    const value: unknown = JSON.parse(body)
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    return JSON.stringify({ ...(value as Record<string, unknown>), model: SYNAPSE_AUTO_ROUTE })
  } catch {
    return undefined
  }
}

/**
 * The error text of a Synapse MCP chat reply (JSON or SSE `data:` lines) that carries a tool
 * error, else undefined. A normal reply is never classified, whatever words it contains.
 */
export function mcpToolErrorText(rawText: string): string | undefined {
  for (const chunk of rawText.split(/(?:^|\n)data:\s*/g)) {
    if (!chunk.trim()) continue
    let data: any
    try {
      data = JSON.parse(chunk.trim())
    } catch {
      continue
    }
    if (!(data?.isError || data?.result?.isError || data?.result?.structuredContent?.error || data?.error)) continue
    const error = data.result?.structuredContent?.error ?? data.error ?? data.result?.content?.[0]?.text
    return typeof error === "string" ? error : JSON.stringify(error ?? "")
  }
  return undefined
}

/** How long a failed pinned model is skipped (straight to `auto`) for one session. */
export const PINNED_FAILURE_TTL_MS = 10 * 60_000
const MEMORY_MAX_ENTRIES = 1000

/**
 * Per-session memory of pinned models that just failed, in process memory only. While a model
 * is marked, the next steps go straight to `auto`; the mark expires after `ttlMs`. The person is
 * told (and the fallback logged) once per session and model.
 */
export class PinnedFallbackMemory {
  private readonly failed = new Map<string, number>()
  /** When each session and model may be reported again: the same TTL as its failure mark. */
  private readonly reported = new Map<string, number>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? PINNED_FAILURE_TTL_MS
    this.now = options.now ?? Date.now
  }

  private static key(session: string, model: string): string {
    return JSON.stringify([session, model])
  }

  isFailed(session: string, model: string): boolean {
    const key = PinnedFallbackMemory.key(session, model)
    const until = this.failed.get(key)
    if (until === undefined) return false
    if (until > this.now()) return true
    this.failed.delete(key)
    return false
  }

  markFailed(session: string, model: string): void {
    const key = PinnedFallbackMemory.key(session, model)
    const now = this.now()
    this.failed.delete(key)
    this.failed.set(key, now + this.ttlMs)
    for (const [k, until] of this.failed) if (until <= now) this.failed.delete(k)
    for (const [k, until] of this.reported) if (until <= now) this.reported.delete(k)
    while (this.failed.size > MEMORY_MAX_ENTRIES) {
      const oldest = this.failed.keys().next().value
      if (oldest === undefined) break
      this.failed.delete(oldest)
    }
  }

  /** True once per session and model until the TTL passes; a failure after that is reported again. */
  shouldReport(session: string, model: string): boolean {
    const key = PinnedFallbackMemory.key(session, model)
    const now = this.now()
    const until = this.reported.get(key)
    if (until !== undefined && until > now) return false
    this.reported.delete(key)
    this.reported.set(key, now + this.ttlMs)
    while (this.reported.size > MEMORY_MAX_ENTRIES) {
      const oldest = this.reported.keys().next().value
      if (oldest === undefined) break
      this.reported.delete(oldest)
    }
    return true
  }
}

/** Why the model cannot serve this request, or undefined when `auto` would not help. */
export function classifyModelUnusable(status: number, body: string): PinnedFallbackReason | undefined {
  if (status === 401 || status === 403) return undefined
  if (SUBSTITUTION_DECLINED.test(body)) return undefined
  if (CONTEXT_OR_VALIDATION.test(body)) return undefined
  if (NO_TOOL_SUPPORT.test(body)) return "no-tool-support"
  // Synapse#1813: the unmet-capability refusal names the capability it could not meet.
  if (/(unmet|unsupported|missing)[ _-]?capabilit/i.test(body) && /\btools?\b/i.test(body)) return "no-tool-support"
  if (status === 402 || BUDGET_CODE.test(body)) return "budget"
  if (BUDGET_WORDS.test(body) && AVAILABILITY.test(body)) return "budget"
  if (status === 429 || /rate_limited/i.test(body)) return "rate-limited"
  const code = errorCodeOf(body)
  if ((code !== undefined && MODEL_NOT_AVAILABLE_CODES.has(code)) || MODEL_NOT_AVAILABLE_TEXT.test(body)) return "model-unavailable"
  // A plain route-not-found 404 is not about the model, so `auto` would not help.
  if (status === 404 && MODEL_MISSING.test(body) && !ROUTE_MISSING.test(body)) return "model-unavailable"
  return undefined
}

export interface PinnedFallbackInput {
  /** The model the request named. */
  model: unknown
  /** The body that was sent (JSON text). Anything else is never resent. */
  body: unknown
  /** The headers that were sent; the resend reuses them. */
  headers: Headers
  response: Response
  enabled: boolean
  signal?: AbortSignal | null
  /** Send `body` again with the same URL, init and headers. */
  resend: (body: string) => Promise<Response>
  /** An error found in the first event of an HTTP 200 stream (peekSseError); `response` is then ok. */
  streamError?: StreamError
}

/**
 * The response to return: the `auto` reply when the fallback ran, else the original one.
 * Runs at most one resend and never throws.
 */
export async function pinnedModelFallback(
  input: PinnedFallbackInput,
): Promise<{ response: Response; event?: PinnedFallbackEvent; originalErrorBody?: string }> {
  const { response, streamError } = input
  if (!input.enabled || (response.ok && !streamError) || !isPinnedModel(input.model) || typeof input.body !== "string") {
    return { response }
  }
  if (input.signal?.aborted) return { response }
  const status = streamError?.status ?? response.status
  if (status === 401 || status === 403) return { response }

  // A stream error was already read by the peek; never read a streaming body to its end here.
  const errorBody = streamError
    ? streamError.text
    : await response
        .clone()
        .text()
        .catch(() => "")
  const reason = classifyModelUnusable(status, errorBody)
  if (!reason) return { response }

  const autoBody = withAutoModel(input.body)
  if (!autoBody) return { response }

  let fallback: Response
  try {
    fallback = await input.resend(autoBody)
  } catch {
    return { response }
  }
  void response.body?.cancel().catch(() => undefined)

  const servedModel = fallback.headers.get("x-synapse-served-model") ?? undefined
  return {
    response: fallback,
    originalErrorBody: errorBody,
    event: {
      originalModel: input.model,
      reason,
      status,
      fallbackModel: SYNAPSE_AUTO_ROUTE,
      fallbackStatus: fallback.status,
      ...(servedModel ? { servedModel } : {}),
      localOnly: input.headers.get("x-privacy-tier") === "local-only",
      ...(streamError ? { inStream: true } : {}),
    },
  }
}

const REASON_WORDS: Record<PinnedFallbackReason, string> = {
  budget: "out of credit or budget",
  "no-tool-support": "cannot use tools",
  "model-unavailable": "not available",
  "rate-limited": "rate limited",
}

/** One line for the person: which model failed, why, and what served the request instead. */
export function pinnedFallbackNotice(event: PinnedFallbackEvent): string {
  const served = event.servedModel ? ` (served by ${event.servedModel})` : ""
  const outcome = event.fallbackStatus >= 200 && event.fallbackStatus < 300 ? `used Synapse auto${served}` : `Synapse auto also failed (HTTP ${event.fallbackStatus})`
  const where = event.inStream ? `error in stream, HTTP ${event.status}` : `HTTP ${event.status}`
  return `${event.originalModel} is ${REASON_WORDS[event.reason]} (${where}); ${outcome}.`
}

// #80 follow-up: with stream:true Synapse answers HTTP 200 text/event-stream and puts a failure
// in the FIRST event (`event: error`, or `data: {"error": ...}` before any `choices`). The plugin
// peeks at that first event only, then hands on a stream with the same bytes.
//
// Bounds: the peek stops at the first complete event (a blank line), at SSE_PEEK_MAX_BYTES, or at
// SSE_PEEK_TIMEOUT_MS, whichever comes first. A Synapse refusal is one small event sent at once,
// so 64 KB and 15 s are generous; a slow first token is never lost, because the read still in
// flight at the deadline is handed on to the rebuilt stream, not dropped.

/** The most of a stream the peek reads before it hands the stream on unchanged. */
export const SSE_PEEK_MAX_BYTES = 64 * 1024
/** How long the peek waits for the first event before it hands the stream on unchanged. */
export const SSE_PEEK_TIMEOUT_MS = 15_000
/** The status given to an error event that does not carry its own. */
export const SSE_ERROR_DEFAULT_STATUS = 502

export interface StreamError {
  status: number
  /** The first event's data (the error JSON), for classifyModelUnusable. */
  text: string
}

export function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
}

/** The end of the first event: the index just after its blank line, or -1. */
function firstEventEnd(text: string): number {
  const match = /\r?\n\r?\n|\r\r/.exec(text)
  return match ? match.index + match[0].length : -1
}

/** The error in one SSE event block, or undefined when it is not an error. */
function eventError(block: string): StreamError | undefined {
  let name = ""
  const data: string[] = []
  for (const line of block.split(/\r?\n|\r/)) {
    if (line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")
    if (field === "event") name = value
    else if (field === "data") data.push(value)
  }
  const text = data.join("\n")
  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    payload = undefined
  }
  const isError = name === "error" || (payload && typeof payload === "object" && payload.error !== undefined && payload.choices === undefined)
  if (!isError) return undefined
  const error = payload && typeof payload.error === "object" && payload.error !== null ? payload.error : {}
  const numeric = [error.status, error.statusCode, error.code, payload?.status].find(
    (v) => typeof v === "number" && v >= 400 && v < 600,
  )
  return { status: numeric ?? SSE_ERROR_DEFAULT_STATUS, text: text || name }
}

/** True when a block holds only comments or blank lines (a keep-alive), so the peek reads on. */
function isCommentOnly(block: string): boolean {
  return block.split(/\r?\n|\r/).every((line) => line === "" || line.startsWith(":"))
}

/**
 * Read the start of an SSE response up to its first event. Returns a response with the same
 * status, headers and bytes (the bytes read, then the rest of the original stream), and the
 * first event's error when it is one. Cancelling the returned body cancels the original stream.
 * An abort during the peek cancels the original stream and rejects.
 */
export async function peekSseError(
  response: Response,
  options: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal | null } = {},
): Promise<{ response: Response; error?: StreamError }> {
  if (!response.body) return { response }
  const maxBytes = options.maxBytes ?? SSE_PEEK_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? SSE_PEEK_TIMEOUT_MS
  const signal = options.signal ?? undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const decoder = new TextDecoder()
  let text = ""
  let size = 0
  let done = false
  type Chunk = { done: boolean; value?: Uint8Array }
  let pending: Promise<Chunk> | undefined
  let error: StreamError | undefined

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), timeoutMs)
  })
  let onAbort: (() => void) | undefined
  const aborted = new Promise<"aborted">((resolve) => {
    if (!signal) return
    onAbort = () => resolve("aborted")
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })

  try {
    let scanFrom = 0
    while (!done && size <= maxBytes) {
      pending = reader.read()
      const read: Promise<Chunk> = pending
      const result: Chunk | "deadline" | "aborted" = await Promise.race([
        read,
        deadline,
        aborted,
      ])
      if (result === "aborted") {
        await reader.cancel(abortError(signal!)).catch(() => undefined)
        throw abortError(signal!)
      }
      if (result === "deadline") break
      pending = undefined
      if (result.done || !result.value) {
        done = result.done
        if (done) break
        continue
      }
      chunks.push(result.value)
      size += result.value.byteLength
      // Past the bound the stream is handed on unread, even if this chunk ends an event.
      if (size > maxBytes) break
      text += decoder.decode(result.value, { stream: true })
      // Skip keep-alive comment blocks; stop at the first real event.
      let end = firstEventEnd(text.slice(scanFrom))
      while (end !== -1 && isCommentOnly(text.slice(scanFrom, scanFrom + end))) {
        scanFrom += end
        end = firstEventEnd(text.slice(scanFrom))
      }
      if (end !== -1) {
        error = eventError(text.slice(scanFrom, scanFrom + end))
        break
      }
    }
  } finally {
    clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener("abort", onAbort)
  }

  const replay = chunks
  const rebuilt = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of replay) controller.enqueue(chunk)
      if (done) {
        controller.close()
        reader.releaseLock()
      }
    },
    async pull(controller) {
      const next = pending ?? reader.read()
      pending = undefined
      const result = await next
      if (result.done) {
        controller.close()
        reader.releaseLock()
        return
      }
      if (result.value) controller.enqueue(result.value)
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined)
    },
  })
  return {
    response: new Response(rebuilt, { status: response.status, statusText: response.statusText, headers: response.headers }),
    ...(error ? { error } : {}),
  }
}
