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

/** Why the model cannot serve this request, or undefined when `auto` would not help. */
export function classifyModelUnusable(status: number, body: string): PinnedFallbackReason | undefined {
  if (status === 401 || status === 403) return undefined
  if (CONTEXT_OR_VALIDATION.test(body)) return undefined
  if (/no endpoints found that support tool use|does not support (tools|tool use|function calling)/i.test(body)) {
    return "no-tool-support"
  }
  // Synapse#1813: the unmet-capability refusal names the capability it could not meet.
  if (/(unmet|unsupported|missing)[ _-]?capabilit/i.test(body) && /\btools?\b/i.test(body)) return "no-tool-support"
  if (status === 402 || /budget_exhausted|insufficient|credit/i.test(body)) return "budget"
  if (status === 429 || /rate_limited/i.test(body)) return "rate-limited"
  if (status === 404 || /model_not_found|model_unavailable/i.test(body)) return "model-unavailable"
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
): Promise<{ response: Response; event?: PinnedFallbackEvent }> {
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

  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(input.body)
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { response }
    parsed = value as Record<string, unknown>
  } catch {
    return { response }
  }

  let fallback: Response
  try {
    fallback = await input.resend(JSON.stringify({ ...parsed, model: SYNAPSE_AUTO_ROUTE }))
  } catch {
    return { response }
  }
  void response.body?.cancel().catch(() => undefined)

  const servedModel = fallback.headers.get("x-synapse-served-model") ?? undefined
  return {
    response: fallback,
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
