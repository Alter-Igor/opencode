// FEAT-OCD-001 MOD-05: the inbox sidecar's HTTP routes (technical-design.md §7, review G5).
//
// HONEST SECURITY MODEL
// - Two listeners (W2C-05). The BOX listener (port 8080, on `sealed`) serves only the box routes;
//   the ADMIN listener (port 8081, bound to the sidecar's address on the `admin` network, which
//   the box is not on) serves only the admin routes. The gate container forwards host
//   127.0.0.1:<inbox port> to it. Admin routes also need the admin token.
// - Box routes (no token): anything running in the box can call them and can claim to be ANY
//   session. So every box message is stored `verified:false` with the claimed `session:<id>`
//   sender, and a `supervisor:` sender is refused (403). Box reads are not access-controlled
//   between sessions either: any in-box code can read any session inbox.
// - Admin routes (Bearer admin token): only bridges hold the token. It is generated per box start,
//   lives in the bridge's memory and in THIS container's env, and is never given to the box. So
//   `supervisor:<name>` messages are `verified:true`: they came from a bridge (not WHICH bridge).
// - Every request must name an allowed Host, and every POST must be application/json (W2C-13).
// - The sidecar stamps `id`, `at`, `verified` and `hops` itself; a client's `hops` is ignored.
//   It is append-only: no route can change or delete a message.
// - Limits, checked in this order: hop limit per thread (box posts count every message in the
//   thread; supervisor posts count only supervisor posts, so box traffic cannot lock a supervisor
//   out, W2C-07), then the box-wide budget (60/min to sessions and a separate 30/min to
//   supervisors, W2C-10), then 10/min per claimed sender (at most 1000 senders tracked, W2C-09).
//   The hop limit is a courtesy brake: in-box code can open a new thread at any time, so the
//   rate limits are the real bound on a loop.
// - Logs never contain message text: only ids, sizes, addresses and codes. Refusal lines are
//   sampled (at most 30 a minute, plus a count of the rest) so a flood cannot fill the disk.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { LogSampler, RateLimiter, WINDOW_MS } from "./limits.ts"
import {
  BOX_ROUTE_PER_MINUTE, BOX_TO_SUPERVISOR_PER_MINUTE, HOP_LIMIT, MAX_BODY_BYTES, MAX_TRACKED_SENDERS, PER_SENDER_PER_MINUTE, SUPERVISOR_ADDRESS,
  textBytes, type StoredMessage,
} from "./rules.ts"
import type { InboxStore, ThreadState } from "./store.ts"
import { fail, isFailure, parseAdminPost, parseBoxPost, parseReadQuery, type Failure } from "./validate.ts"

export type LogLine = { level: "info" | "warn" | "error"; event: string } & Record<string, string | number | boolean | undefined>
export type LogSink = (line: LogLine) => void
export type Handler = (request: Request) => Promise<Response>

export type HandlerOptions = {
  store: InboxStore
  adminToken: string
  /** Host headers (host:port) the box listener accepts, e.g. `inbox:8080`. */
  boxHosts: string[]
  /** Host headers the admin listener accepts, e.g. `127.0.0.1:<published port>`. */
  adminHosts: string[]
  now?: () => number
  log?: LogSink
}

/** One handler per listener, plus the timer-driven prune (`stop` ends the timer). */
export type Handlers = { box: Handler; admin: Handler; prune: () => void; stop: () => void }

const REFUSAL_LINES_PER_MINUTE = 30

type Context = {
  store: InboxStore
  adminToken: string
  now: () => number
  log: LogSink
  perSender: RateLimiter
  toSessions: RateLimiter
  toSupervisors: RateLimiter
  refusals: LogSampler
}

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
  if (ctx.refusals.allow()) ctx.log({ level: "warn", event: "refused", route, status: error.status, code: error.code, ...fields })
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

type Draft = { from: string; to: string; text: string; verified: boolean; correlationId?: string }

/**
 * Hop index for a new message, or undefined when the thread is over the limit. The stored index
 * counts every message in the thread; a supervisor post is judged only on how many supervisor
 * posts the thread already has, so unverified box posts cannot use up a supervisor's hops.
 */
export function nextHops(thread: Readonly<ThreadState> | undefined, verified: boolean): number | undefined {
  const index = thread === undefined ? 0 : thread.hops + 1
  if (verified) return (thread?.verifiedCount ?? 0) > HOP_LIMIT ? undefined : index
  return index > HOP_LIMIT ? undefined : index
}

/** Box-wide budget first (by destination), then the per-sender one (W2C-09, W2C-10). */
function takeBudget(ctx: Context, draft: Draft): Failure | undefined {
  if (!draft.verified) {
    const toSupervisor = SUPERVISOR_ADDRESS.test(draft.to)
    const limiter = toSupervisor ? ctx.toSupervisors : ctx.toSessions
    if (limiter.take("box") !== "ok")
      return toSupervisor
        ? fail(429, "rate_limited", `At most ${BOX_TO_SUPERVISOR_PER_MINUTE} messages a minute from the box to supervisors.`)
        : fail(429, "rate_limited", `At most ${BOX_ROUTE_PER_MINUTE} messages a minute from the box to sessions.`)
  }
  const sender = ctx.perSender.take(draft.from)
  if (sender === "full") return fail(429, "rate_limited", "Too many different senders this minute; wait a minute and retry.")
  if (sender === "limited") return fail(429, "rate_limited", `At most ${PER_SENDER_PER_MINUTE} messages a minute per sender.`)
  return undefined
}

/** Hop check, then rate budget (W2C-11), then stamp id/at/hops and append. */
function store(ctx: Context, route: string, draft: Draft): Response {
  const correlationId = draft.correlationId ?? `c_${randomBytes(8).toString("hex")}`
  const hops = nextHops(ctx.store.thread(correlationId), draft.verified)
  if (hops === undefined)
    return failure(ctx, route, fail(429, "hop_limit", `This thread already has ${HOP_LIMIT} hops; start a new one only if a person asked.`), { from: draft.from, correlationId })
  const budget = takeBudget(ctx, draft)
  if (budget) return failure(ctx, route, budget, { from: draft.from })
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

/** The complete route tables, one per listener. Anything else, including other methods, is 404. */
const BOX_ROUTES: Record<string, Route> = {
  "POST /v1/post": (ctx, request) => boxPost(ctx, request),
  "GET /v1/read": (ctx, _request, url) => read(ctx, url, "box"),
}
const ADMIN_ROUTES: Record<string, Route> = {
  "POST /v1/admin/post": (ctx, request) => adminPost(ctx, request),
  "GET /v1/admin/read": (ctx, _request, url) => read(ctx, url, "admin"),
}

const JSON_TYPE = /^application\/json\s*(;.*)?$/i

/** Why a request is refused before its route runs (Host, token, content type), or undefined. */
function gateCheck(ctx: Context, request: Request, hosts: Set<string>, admin: boolean): Failure | undefined {
  if (!hosts.has((request.headers.get("host") ?? "").toLowerCase())) return fail(421, "bad_host", "This inbox does not answer to that Host.")
  if (admin && !tokenMatches(request.headers.get("authorization"), ctx.adminToken)) return fail(401, "unauthorized", "The admin token is missing or wrong.")
  if (request.method === "POST" && !JSON_TYPE.test(request.headers.get("content-type") ?? ""))
    return fail(415, "unsupported_media_type", "POST bodies must be sent as application/json.")
  return undefined
}

function listener(ctx: Context, routes: Record<string, Route>, hostList: string[], admin: boolean): Handler {
  const hosts = new Set(hostList.map((host) => host.toLowerCase()))
  return async (request) => {
    const url = new URL(request.url)
    const route = routes[`${request.method} ${url.pathname}`]
    if (!route) return failure(ctx, url.pathname.slice(0, 60), fail(404, "not_found", "No such route."), { method: request.method })
    const refused = gateCheck(ctx, request, hosts, admin)
    if (refused) return failure(ctx, url.pathname, refused)
    try {
      return await route(ctx, request, url)
    } catch (error) {
      ctx.log({ level: "error", event: "failed", route: url.pathname, status: 500, detail: error instanceof Error ? error.name : "unknown" })
      return json(500, { error: { code: "internal", message: "The inbox could not handle the request." } })
    }
  }
}

export function createHandlers(options: HandlerOptions): Handlers {
  const now = options.now ?? Date.now
  const ctx: Context = {
    store: options.store, adminToken: options.adminToken, now, log: options.log ?? (() => {}),
    perSender: new RateLimiter(PER_SENDER_PER_MINUTE, now, MAX_TRACKED_SENDERS),
    toSessions: new RateLimiter(BOX_ROUTE_PER_MINUTE, now),
    toSupervisors: new RateLimiter(BOX_TO_SUPERVISOR_PER_MINUTE, now),
    refusals: new LogSampler(REFUSAL_LINES_PER_MINUTE, now),
  }
  const prune = () => {
    for (const limiter of [ctx.perSender, ctx.toSessions, ctx.toSupervisors]) limiter.prune()
    const dropped = ctx.refusals.flush()
    if (dropped > 0) ctx.log({ level: "warn", event: "refused_suppressed", count: dropped })
  }
  const timer = setInterval(prune, WINDOW_MS)
  timer.unref?.()
  return {
    box: listener(ctx, BOX_ROUTES, options.boxHosts, false),
    admin: listener(ctx, ADMIN_ROUTES, options.adminHosts, true),
    prune,
    stop: () => clearInterval(timer),
  }
}
