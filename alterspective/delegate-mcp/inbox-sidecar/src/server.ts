// FEAT-OCD-001 MOD-05: the inbox sidecar's HTTP routes (technical-design.md §7, review G5).
//
// HONEST SECURITY MODEL
// - Box route (no token): anything running in the box can call it and can claim to be ANY
//   session. So every box-route message is stored `verified:false` with the claimed
//   `session:<id>` sender, and a `supervisor:` sender is refused (403). Box-route reads are not
//   access-controlled between sessions either: any in-box code can read any session inbox.
// - Admin route (Bearer admin token): only bridges hold the token. It is generated per box start,
//   lives in the bridge's memory and in THIS container's env, and is never given to the box. So
//   `supervisor:<name>` messages are `verified:true`: they came from a bridge (not WHICH bridge).
// - The sidecar stamps `id`, `at`, `verified` and `hops` itself. It is append-only: no route can
//   change or delete a message. Limits: text <= 8 KB, hop limit 3 per thread, 10 msgs/min per
//   claimed sender plus 60/min over the whole box route.
// - Logs never contain message text: only ids, sizes, addresses and codes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { RateLimiter } from "./limits.ts"
import { BOX_ROUTE_PER_MINUTE, HOP_LIMIT, MAX_BODY_BYTES, PER_SENDER_PER_MINUTE, textBytes, type StoredMessage } from "./rules.ts"
import type { InboxStore } from "./store.ts"
import { fail, isFailure, parseAdminPost, parseBoxPost, parseReadQuery, type Failure } from "./validate.ts"

export type LogLine = { level: "info" | "warn" | "error"; event: string } & Record<string, string | number | boolean | undefined>
export type LogSink = (line: LogLine) => void

export type HandlerOptions = {
  store: InboxStore
  adminToken: string
  now?: () => number
  log?: LogSink
}

type Context = Required<HandlerOptions> & { perSender: RateLimiter; boxRoute: RateLimiter }

/** Constant-time token check. Both sides are hashed first so their lengths always match. */
export function tokenMatches(header: string | null, expected: string): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "")
  if (!match || expected.length === 0) return false
  const presented = createHash("sha256").update(match[1]!).digest()
  const wanted = createHash("sha256").update(expected).digest()
  return timingSafeEqual(presented, wanted)
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
}

function failure(ctx: Context, route: string, error: Failure, fields: Record<string, string | number | undefined> = {}): Response {
  ctx.log({ level: "warn", event: "refused", route, status: error.status, code: error.code, ...fields })
  return json(error.status, { error: { code: error.code, message: error.message } })
}

async function readBody(request: Request): Promise<unknown | Failure> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_BODY_BYTES) return fail(413, "body_too_large", `The body is over ${MAX_BODY_BYTES} bytes.`)
  const text = await request.text()
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return fail(413, "body_too_large", `The body is over ${MAX_BODY_BYTES} bytes.`)
  try {
    return JSON.parse(text)
  } catch {
    return fail(400, "invalid_body", "The body is not valid JSON.")
  }
}

type Draft = { from: string; to: string; text: string; verified: boolean; hops?: number; correlationId?: string }

/** Rate limit, stamp hops/correlationId/at, then append. Hops are the max of the claim and the thread + 1. */
function store(ctx: Context, route: string, draft: Draft): Response {
  if (!ctx.perSender.take(draft.from)) return failure(ctx, route, fail(429, "rate_limited", `At most ${PER_SENDER_PER_MINUTE} messages a minute per sender.`), { from: draft.from })
  if (!draft.verified && !ctx.boxRoute.take("box"))
    return failure(ctx, route, fail(429, "rate_limited", `At most ${BOX_ROUTE_PER_MINUTE} messages a minute from the box.`), { from: draft.from })
  const correlationId = draft.correlationId ?? `c_${randomBytes(8).toString("hex")}`
  const prior = ctx.store.threadHops(correlationId)
  const hops = Math.max(draft.hops ?? 0, prior === undefined ? 0 : prior + 1)
  if (hops > HOP_LIMIT) return failure(ctx, route, fail(429, "hop_limit", `This thread already has ${HOP_LIMIT} hops; start a new one only if a person asked.`), { from: draft.from, correlationId })
  const message: StoredMessage = ctx.store.append({
    at: new Date(ctx.now()).toISOString(), from: draft.from, to: draft.to, text: draft.text, hops, verified: draft.verified, correlationId,
  })
  ctx.log({ level: "info", event: "stored", route, status: 201, id: message.id, from: message.from, to: message.to, bytes: textBytes(message.text), hops, verified: message.verified })
  return json(201, { message })
}

async function boxPost(ctx: Context, request: Request): Promise<Response> {
  const body = await readBody(request)
  if (isFailure(body)) return failure(ctx, "post", body)
  const input = parseBoxPost(body)
  if (isFailure(input)) return failure(ctx, "post", input)
  return store(ctx, "post", { ...input, verified: false })
}

async function adminPost(ctx: Context, request: Request): Promise<Response> {
  const body = await readBody(request)
  if (isFailure(body)) return failure(ctx, "admin/post", body)
  const input = parseAdminPost(body)
  if (isFailure(input)) return failure(ctx, "admin/post", input)
  return store(ctx, "admin/post", { from: input.as, to: input.to, text: input.text, correlationId: input.correlationId, verified: true })
}

function read(ctx: Context, url: URL, route: "box" | "admin"): Response {
  const name = route === "box" ? "read" : "admin/read"
  const query = parseReadQuery(url, route)
  if (isFailure(query)) return failure(ctx, name, query)
  const page = ctx.store.read(query.to, query.cursor, query.limit)
  ctx.log({ level: "info", event: "read", route: name, status: 200, to: query.to, count: page.messages.length, next: page.next })
  return json(200, page)
}

type Route = (ctx: Context, request: Request, url: URL) => Response | Promise<Response>

/** The complete route table. Anything else, including other methods on these paths, is 404. */
const ROUTES: Record<string, { admin: boolean; run: Route }> = {
  "POST /v1/post": { admin: false, run: (ctx, request) => boxPost(ctx, request) },
  "GET /v1/read": { admin: false, run: (ctx, _request, url) => read(ctx, url, "box") },
  "POST /v1/admin/post": { admin: true, run: (ctx, request) => adminPost(ctx, request) },
  "GET /v1/admin/read": { admin: true, run: (ctx, _request, url) => read(ctx, url, "admin") },
}

export function createHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? Date.now
  const ctx: Context = {
    store: options.store, adminToken: options.adminToken, now, log: options.log ?? (() => {}),
    perSender: new RateLimiter(PER_SENDER_PER_MINUTE, now), boxRoute: new RateLimiter(BOX_ROUTE_PER_MINUTE, now),
  }
  return async (request) => {
    const url = new URL(request.url)
    const route = ROUTES[`${request.method} ${url.pathname}`]
    if (!route) return failure(ctx, url.pathname.slice(0, 60), fail(404, "not_found", "No such route."), { method: request.method })
    if (route.admin && !tokenMatches(request.headers.get("authorization"), ctx.adminToken))
      return failure(ctx, url.pathname, fail(401, "unauthorized", "The admin token is missing or wrong."))
    try {
      return await route.run(ctx, request, url)
    } catch (error) {
      ctx.log({ level: "error", event: "failed", route: url.pathname, status: 500, detail: error instanceof Error ? error.name : "unknown" })
      return json(500, { error: { code: "internal", message: "The inbox could not handle the request." } })
    }
  }
}
