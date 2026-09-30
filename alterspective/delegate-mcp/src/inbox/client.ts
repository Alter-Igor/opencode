// FEAT-OCD-001 MOD-05: the bridge's side of the agent inbox (contracts.ts Inbox, technical-design §7).
// Talks to the sidecar's admin routes with the admin token, so what it posts is stored
// verified:true as `supervisor:<name>`. Every failure is a DelegateError: a read that failed is
// inbox_unavailable, never an empty list. The token never appears in errors or logs.
//
// Cursors (W2C-08): `next` is `<epoch>.<id>`. The epoch is random per inbox data volume, so a
// cursor kept across a sandbox reset (`down -v`) is caught: an epoch mismatch, or an id above the
// inbox's last id, is `cursor_expired`. A bare `<id>` is still accepted (no epoch check). When
// retention dropped messages after the cursor, the page says `truncated: true`.
import { CORRELATION_ID, EPOCH, MAX_READ_LIMIT, MAX_TEXT_BYTES, SUPERVISOR_ADDRESS, isAddress, textBytes } from "../../inbox-sidecar/src/rules.ts"
import type { Inbox, InboxMessage } from "../shared/contracts.ts"
import { DelegateError } from "../shared/errors.ts"

export type InboxTarget = { baseUrl: string; token: string }

export type InboxOptions = {
  /** This bridge's address, `supervisor:<name>`. */
  supervisor: string
  /** Where the admin API is and its token (target.ts resolves it from Docker). */
  target: () => Promise<InboxTarget>
  /** Forget a cached target (called after a 401: the box may have been restarted by another bridge). */
  invalidate?: () => void
  fetch?: typeof fetch
  timeoutMs?: number
}

export const DEFAULT_INBOX_TIMEOUT_MS = 10_000

/** Inbox.read result plus `truncated` (contract addition, W2C-08): messages after the cursor were dropped by retention. */
export type InboxPage = { messages: InboxMessage[]; next: string; truncated: boolean }

/** The bridge's inbox: Inbox with the richer read result (still assignable to Inbox). */
export type BridgeInbox = Omit<Inbox, "read"> & { read(cursor?: string, limit?: number): Promise<InboxPage> }

type Reply = { status: number; data: unknown }

function unavailable(message: string, detail: string): DelegateError {
  return new DelegateError("inbox_unavailable", message, "Run oc_doctor; if the sandbox was restarted, retry. Do not treat this as \"no messages\".", detail)
}

function invalid(message: string, detail?: string): DelegateError {
  return new DelegateError("invalid_input", message, "Fix the request and retry.", detail)
}

function serverError(reply: Reply): { code: string; message: string } {
  const error = (reply.data as { error?: { code?: unknown; message?: unknown } } | undefined)?.error
  return { code: typeof error?.code === "string" ? error.code : "unknown", message: typeof error?.message === "string" ? error.message.slice(0, 200) : "" }
}

/** Sidecar refusals → stable codes. 4xx are the caller's to fix; anything else is the inbox's fault. */
export function mapFailure(reply: Reply, what: string): DelegateError {
  const { code, message } = serverError(reply)
  const detail = `HTTP ${reply.status} ${code}`
  if (reply.status === 429)
    return new DelegateError("inbox_limited", `The inbox limit was reached: ${message || code}`, "Wait a minute before sending again, or start a new thread only if a person asked.", detail)
  if (reply.status === 400 || reply.status === 403 || reply.status === 413) return invalid(`The inbox refused to ${what}: ${message || code}`, detail)
  return unavailable(`The agent inbox failed to ${what}.`, detail)
}

function isMessage(value: unknown): value is InboxMessage {
  const m = value as Partial<InboxMessage> | undefined
  return (
    typeof m === "object" && m !== null && typeof m.id === "string" && typeof m.at === "string" && typeof m.from === "string" &&
    typeof m.to === "string" && typeof m.text === "string" && typeof m.hops === "number" && typeof m.verified === "boolean" &&
    (m.correlationId === undefined || typeof m.correlationId === "string")
  )
}

function checkPost(to: string, text: string, correlationId: string | undefined): void {
  if (!isAddress(to)) throw invalid("`to` must be supervisor:<name> or session:ses_<id>.")
  if (text.length === 0) throw invalid("The message text is empty.")
  if (textBytes(text) > MAX_TEXT_BYTES) throw invalid(`The message is over ${MAX_TEXT_BYTES} bytes.`)
  if (correlationId !== undefined && !CORRELATION_ID.test(correlationId)) throw invalid("`correlationId` must be 1-64 characters of A-Z a-z 0-9 . _ : -.")
}

type Send = (method: "GET" | "POST", route: string, body?: unknown) => Promise<Reply>

function transport(options: InboxOptions): Send {
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_INBOX_TIMEOUT_MS

  async function once(method: "GET" | "POST", route: string, body: unknown): Promise<Reply> {
    const target = await options.target()
    const headers: Record<string, string> = { authorization: `Bearer ${target.token}` }
    if (body !== undefined) headers["content-type"] = "application/json"
    try {
      const res = await fetchImpl(new URL(route, target.baseUrl), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
      const text = await res.text()
      return { status: res.status, data: text ? safeJson(text) : undefined }
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      throw unavailable(timeout ? "The agent inbox did not answer in time." : "The agent inbox is not reachable.", timeout ? "timeout" : error instanceof Error ? error.name : "fetch failed")
    }
  }

  /** One retry after a 401 with a freshly resolved target; a 401 is never stored, so it cannot duplicate. */
  async function request(method: "GET" | "POST", route: string, body?: unknown): Promise<Reply> {
    let reply = await once(method, route, body)
    if (reply.status === 401 && options.invalidate) {
      options.invalidate()
      reply = await once(method, route, body)
    }
    if (reply.status === 401) throw unavailable("The agent inbox rejected this bridge's token.", "HTTP 401")
    return reply
  }
  return request
}

const CLIENT_CURSOR = /^(?:([0-9a-f]{16})\.)?(\d{1,15})$/
const DIGITS = /^\d{1,15}$/

type Cursor = { epoch?: string; id: number }
type RawPage = { messages: InboxMessage[]; next: string; epoch: string; oldestId: number; lastId: number }

export function parseCursor(cursor: string | undefined): Cursor {
  if (cursor === undefined) return { id: 0 }
  const match = CLIENT_CURSOR.exec(cursor)
  if (!match) throw invalid("The inbox cursor is not one this bridge returned.")
  return { epoch: match[1], id: Number(match[2]) }
}

function rawPage(data: unknown): RawPage {
  const page = data as { messages?: unknown; next?: unknown; epoch?: unknown; oldestId?: unknown; lastId?: unknown } | undefined
  const digits = (value: unknown): value is string => typeof value === "string" && DIGITS.test(value)
  const ok =
    Array.isArray(page?.messages) && page.messages.every(isMessage) && digits(page.next) &&
    typeof page.epoch === "string" && EPOCH.test(page.epoch) && digits(page.oldestId) && digits(page.lastId)
  if (!ok || !page) throw unavailable("The agent inbox gave an unreadable answer.", "read: bad page shape")
  return { messages: page.messages as InboxMessage[], next: String(page.next), epoch: String(page.epoch), oldestId: Number(page.oldestId), lastId: Number(page.lastId) }
}

function expired(detail: string): DelegateError {
  return new DelegateError(
    "cursor_expired",
    "The inbox cursor is from an earlier inbox: the sandbox's inbox was reset since it was issued.",
    "Read again without a cursor to start from the oldest message still kept.",
    detail,
  )
}

/** Cursor checks against the page (epoch, last id) and the gap flag (W2C-08). */
export function toPage(cursor: Cursor, page: RawPage): InboxPage {
  if (cursor.epoch !== undefined && cursor.epoch !== page.epoch) throw expired("epoch mismatch")
  if (cursor.id > page.lastId) throw expired(`cursor ${cursor.id} > last id ${page.lastId}`)
  return { messages: page.messages, next: `${page.epoch}.${page.next}`, truncated: cursor.id + 1 < page.oldestId }
}

export function createInbox(options: InboxOptions): BridgeInbox {
  if (!SUPERVISOR_ADDRESS.test(options.supervisor)) throw invalid("The bridge's inbox address must be supervisor:<name> (a-z, 0-9, -; up to 40).")
  const request = transport(options)
  return {
    async post(to, text, opts = {}) {
      checkPost(to, text, opts.correlationId)
      const reply = await request("POST", "/v1/admin/post", { as: options.supervisor, to, text, correlationId: opts.correlationId })
      if (reply.status !== 201) throw mapFailure(reply, "store the message")
      const message = (reply.data as { message?: unknown } | undefined)?.message
      if (!isMessage(message)) throw unavailable("The agent inbox gave an unreadable answer.", "post: bad message shape")
      return message
    },
    async read(cursor, limit) {
      const parsed = parseCursor(cursor)
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT)) throw invalid(`\`limit\` must be 1-${MAX_READ_LIMIT}.`)
      const query = new URLSearchParams({ to: options.supervisor, cursor: String(parsed.id) })
      if (limit !== undefined) query.set("limit", String(limit))
      const reply = await request("GET", `/v1/admin/read?${query}`)
      if (reply.status !== 200) throw mapFailure(reply, "read messages")
      return toPage(parsed, rawPage(reply.data))
    },
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
