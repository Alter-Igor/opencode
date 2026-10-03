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
const MODEL_NOT_AVAILABLE = /model_not_found|model_unavailable|model_not_available|no available instance serves model/i
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
  if (MODEL_NOT_AVAILABLE.test(body)) return "model-unavailable"
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
}

/**
 * The response to return: the `auto` reply when the fallback ran, else the original one.
 * Runs at most one resend and never throws.
 */
export async function pinnedModelFallback(
  input: PinnedFallbackInput,
): Promise<{ response: Response; event?: PinnedFallbackEvent; originalErrorBody?: string }> {
  const { response } = input
  if (!input.enabled || response.ok || !isPinnedModel(input.model) || typeof input.body !== "string") {
    return { response }
  }
  if (input.signal?.aborted) return { response }
  if (response.status === 401 || response.status === 403) return { response }

  const errorBody = await response
    .clone()
    .text()
    .catch(() => "")
  const reason = classifyModelUnusable(response.status, errorBody)
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
      status: response.status,
      fallbackModel: SYNAPSE_AUTO_ROUTE,
      fallbackStatus: fallback.status,
      ...(servedModel ? { servedModel } : {}),
      localOnly: input.headers.get("x-privacy-tier") === "local-only",
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
  return `${event.originalModel} is ${REASON_WORDS[event.reason]} (HTTP ${event.status}); ${outcome}.`
}
