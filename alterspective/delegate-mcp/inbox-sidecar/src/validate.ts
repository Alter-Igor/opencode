// FEAT-OCD-001 MOD-05: request validation for the inbox routes. Every check fails closed and
// names the problem without echoing the message text back.
import {
  CORRELATION_ID, CURSOR, DEFAULT_READ_LIMIT, MAX_READ_LIMIT, MAX_TEXT_BYTES, SESSION_ADDRESS, SUPERVISOR_ADDRESS, isAddress, textBytes,
} from "./rules.ts"

export type Failure = { failure: true; status: number; code: string; message: string }

export type BoxPost = { from: string; to: string; text: string; hops?: number; correlationId?: string }
export type AdminPost = { as: string; to: string; text: string; correlationId?: string }
export type ReadQuery = { to: string; cursor: number; limit: number }

export function fail(status: number, code: string, message: string): Failure {
  return { failure: true, status, code, message }
}

export function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && (value as Failure).failure === true
}

function asRecord(body: unknown, allowed: string[]): Record<string, unknown> | Failure {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail(400, "invalid_body", "The body must be a JSON object.")
  const extra = Object.keys(body).filter((key) => !allowed.includes(key))
  // Refusing unknown keys means a caller cannot smuggle `verified`, `id` or `at` in.
  if (extra.length) return fail(400, "unknown_field", `Unknown field(s): ${extra.slice(0, 5).join(", ").slice(0, 120)}.`)
  return body as Record<string, unknown>
}

function checkCommon(body: Record<string, unknown>): Failure | undefined {
  if (!isAddress(body.to)) return fail(400, "bad_address", "`to` must be supervisor:<name> or session:ses_<id>.")
  if (typeof body.text !== "string" || body.text.length === 0) return fail(400, "invalid_body", "`text` must be a non-empty string.")
  if (textBytes(body.text) > MAX_TEXT_BYTES) return fail(413, "text_too_large", `\`text\` is over ${MAX_TEXT_BYTES} bytes.`)
  if (body.correlationId !== undefined && (typeof body.correlationId !== "string" || !CORRELATION_ID.test(body.correlationId)))
    return fail(400, "bad_correlation_id", "`correlationId` must be 1-64 characters of A-Z a-z 0-9 . _ : -.")
  return undefined
}

/** Box route: the sender is only claimed. A `supervisor:` sender is refused here (403). */
export function parseBoxPost(input: unknown): BoxPost | Failure {
  const body = asRecord(input, ["from", "to", "text", "hops", "correlationId"])
  if (isFailure(body)) return body
  if (typeof body.from === "string" && SUPERVISOR_ADDRESS.test(body.from))
    return fail(403, "sender_not_allowed", "Only a bridge (admin route) can send as a supervisor.")
  if (typeof body.from !== "string" || !SESSION_ADDRESS.test(body.from)) return fail(400, "bad_address", "`from` must be session:ses_<id>.")
  const common = checkCommon(body)
  if (common) return common
  if (body.hops !== undefined && (typeof body.hops !== "number" || !Number.isInteger(body.hops) || body.hops < 0 || body.hops > 1000))
    return fail(400, "bad_hops", "`hops` must be a whole number from 0.")
  return { from: body.from, to: body.to as string, text: body.text as string, hops: body.hops as number | undefined, correlationId: body.correlationId as string | undefined }
}

/** Admin route: posts as `supervisor:<name>` only; hops are counted by the sidecar per thread. */
export function parseAdminPost(input: unknown): AdminPost | Failure {
  const body = asRecord(input, ["as", "to", "text", "correlationId"])
  if (isFailure(body)) return body
  if (typeof body.as !== "string" || !SUPERVISOR_ADDRESS.test(body.as)) return fail(400, "bad_address", "`as` must be supervisor:<name>.")
  const common = checkCommon(body)
  if (common) return common
  return { as: body.as, to: body.to as string, text: body.text as string, correlationId: body.correlationId as string | undefined }
}

/** `box`: only session inboxes can be read without the token; `admin`: only supervisor inboxes. */
export function parseReadQuery(url: URL, route: "box" | "admin"): ReadQuery | Failure {
  const to = url.searchParams.get("to") ?? ""
  if (route === "box" && SUPERVISOR_ADDRESS.test(to)) return fail(403, "read_not_allowed", "Supervisor inboxes are read through the admin route only.")
  const pattern = route === "box" ? SESSION_ADDRESS : SUPERVISOR_ADDRESS
  if (!pattern.test(to)) return fail(400, "bad_address", route === "box" ? "`to` must be session:ses_<id>." : "`to` must be supervisor:<name>.")
  const cursorText = url.searchParams.get("cursor") || "0"
  if (!CURSOR.test(cursorText)) return fail(400, "bad_cursor", "`cursor` must be a message id from an earlier read.")
  const limitText = url.searchParams.get("limit")
  const limit = limitText === null || limitText === "" ? DEFAULT_READ_LIMIT : Number(limitText)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) return fail(400, "bad_limit", `\`limit\` must be 1-${MAX_READ_LIMIT}.`)
  return { to, cursor: Number(cursorText), limit }
}
