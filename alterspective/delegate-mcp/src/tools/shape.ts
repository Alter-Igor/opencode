// MOD-04 output shaping (technical-design §5): every tool result is short JSON plus a one-line
// summary; text that came from a session or the box lives only under `untrusted`; errors are
// {code, message, action}. Results are capped so one call cannot flood the client's context.
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { scrub } from "../shared/log.ts"

/** ~8k tokens. Claude Code warns above 10k and truncates at 25k (MAX_MCP_OUTPUT_TOKENS). */
export const MAX_RESULT_CHARS = 32_000
/** Per untrusted text field. */
export const MAX_UNTRUSTED_CHARS = 8_000

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

/** Wrap session/box text so a client never mistakes it for bridge output. */
export function untrusted(text: string | undefined, max = MAX_UNTRUSTED_CHARS): { text: string; truncated: boolean } | undefined {
  if (text === undefined) return undefined
  const clean = text.replace(CONTROL, "")
  return clean.length > max ? { text: clean.slice(0, max), truncated: true } : { text: clean, truncated: false }
}

function render(summary: string, data: Record<string, unknown>): string {
  const body = JSON.stringify(data, null, 2)
  const text = `${summary}\n${body}`
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${summary}\n${body.slice(0, MAX_RESULT_CHARS - summary.length - 80)}\n… [result truncated at ${MAX_RESULT_CHARS} characters; page with a cursor or a smaller limit]`
}

/** A successful tool result. `summary` is bridge-authored text only. */
export function ok(summary: string, data: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: render(summary, data) }], structuredContent: data }
}

/** A failed tool result. Unknown errors become upstream_error with no internals exposed (ERR-MSG-03). */
export function fail(error: unknown): ToolResult {
  const known = isDelegateError(error)
    ? error
    : new DelegateError("upstream_error", "The bridge hit an unexpected error.", "Retry; if it repeats, run oc_doctor.", scrub(String(error)))
  const data = known.toResult()
  return { content: [{ type: "text", text: `${data.code}: ${data.message} (${data.action})` }], structuredContent: data, isError: true }
}
