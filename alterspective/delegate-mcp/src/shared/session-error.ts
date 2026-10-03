// #80: why a session's model failed, from OpenCode's session error object ({ name, data: { message,
// statusCode? } }). Only the error object is read: never prompt or reply text.
//
// `code` is a bridge word from SESSION_ERROR_CODES (safe for summaries and records); anything not
// recognised is "other". The provider message is box-supplied text: callers return it only under
// an untrusted wrapper. It is secret-scrubbed and capped here.
import { scrub } from "./log.ts"
import { stripUnsafe } from "./text.ts"

export const SESSION_ERROR_CODES = [
  "budget_exhausted",
  "rate_limited",
  "no_tool_support",
  "model_not_found",
  "auth",
  "context_overflow",
  "content_filter",
  "output_length",
  "aborted",
  "other",
] as const
export type SessionErrorCode = (typeof SESSION_ERROR_CODES)[number]

/** The most of a provider message the bridge returns. */
export const SESSION_ERROR_MESSAGE_MAX = 500

type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value)

/** OpenCode's own error names that already say what went wrong. */
const BY_NAME: Record<string, SessionErrorCode> = {
  MessageAbortedError: "aborted",
  ProviderAuthError: "auth",
  ContextOverflowError: "context_overflow",
  ContentFilterError: "content_filter",
  MessageOutputLengthError: "output_length",
}

function parts(error: unknown): { name?: string; message?: string; status?: number } {
  if (!isObj(error)) return {}
  const data = isObj(error.data) ? error.data : {}
  return {
    name: typeof error.name === "string" ? error.name : undefined,
    message: typeof data.message === "string" && data.message.length > 0 ? data.message : undefined,
    status: typeof data.statusCode === "number" ? data.statusCode : undefined,
  }
}

/**
 * "No endpoints found that support tool use", Synapse #1815's 404 `model_not_available` ("...
 * required capability: tool calling ... or send the request without tools"; code OR either phrase,
 * as its wording may still change), or an unmet-capability refusal naming tools (Synapse#1813).
 */
export function noToolSupport(message: string): boolean {
  if (/no endpoints found that support tool use|does not support (tools|tool use|function calling)|model_not_available|required capability:\s*tool calling|without tools/i.test(message)) return true
  return /(unmet|unsupported|missing)[ _-]?capabilit/i.test(message) && /\btools?\b/i.test(message)
}

/** A known code for the error, else "other". */
export function sessionErrorCode(error: unknown): SessionErrorCode {
  const { name, message = "", status } = parts(error)
  if (name && BY_NAME[name]) return BY_NAME[name]
  // Same order as the plugin (synapse-fallback.ts): auth and context before budget words.
  if (status === 401 || status === 403) return "auth"
  if (/context_length_exceeded|context window|maximum context/i.test(message)) return "context_overflow"
  if (noToolSupport(message)) return "no_tool_support"
  if (status === 402 || /budget_exhausted|insufficient|credit/i.test(message)) return "budget_exhausted"
  if (status === 429 || /rate_limited|rate limit/i.test(message)) return "rate_limited"
  if (status === 404 || /model_not_found|model_unavailable|model not found/i.test(message)) return "model_not_found"
  if (/unauthori[sz]ed|forbidden/i.test(message)) return "auth"
  return "other"
}

/** The provider message, hidden characters stripped, secret-scrubbed and capped; undefined when there is none. */
export function sessionErrorDetail(error: unknown): string | undefined {
  const { message } = parts(error)
  if (message === undefined) return undefined
  const visible = stripUnsafe(message)
  const cut = visible.length > SESSION_ERROR_MESSAGE_MAX ? visible.slice(0, SESSION_ERROR_MESSAGE_MAX) + "…" : visible
  return scrub(cut, { keepIds: true })
}
