// #104: the gate's two listeners.
//
// Front listener (GATE_PORT, on the internal `gatenet` network only: front reaches it, the box
// cannot): front sends the box's /mcp/dynamic traffic here with the owner's token already set as
// Authorization. The gate applies the delegation profile and the approval fence, then forwards to
// the ONE fixed upstream (Keystone /mcp/dynamic) over verified TLS.
//
// Admin listener (GATE_ADMIN_PORT, on the `admin` network address only; published to the host
// loopback by a socat gate): the bridge lists and decides approvals with the per-start admin token.
//
// Never logged: the Authorization header, tool arguments, or response bodies. Logged: method,
// tool name, decision.
import { timingSafeEqual } from "node:crypto"
import { ApprovalStore } from "./approvals.ts"
import { filterResult, MAX_FILTER_BYTES, planMessage, rewriteSse, toolError, type Message, type Plan } from "./mcp.ts"
import type { Profile } from "./policy.ts"

export type GateConfig = {
  upstream: string
  profile: Profile
  adminToken: string
  approvals: ApprovalStore
  fetch?: typeof fetch
  log?: (event: Record<string, unknown>) => void
}

/** Request headers passed upstream. Everything else (cookies, forwarding headers, Host) is dropped. */
const PASS_REQUEST = ["authorization", "content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"]
/** Response headers passed back. */
const PASS_RESPONSE = ["content-type", "mcp-session-id", "cache-control"]
const MAX_REQUEST_BYTES = 1024 * 1024

const pick = (headers: Headers, names: readonly string[]) => {
  const out = new Headers()
  for (const name of names) {
    const value = headers.get(name)
    if (value !== null) out.set(name, value)
  }
  return out
}

const json = (status: number, body: unknown, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } })

function approvalText(plan: Extract<Plan, { kind: "decide" }>, approval: { id: string; state: string }): string {
  if (approval.state === "denied")
    return `The call to ${plan.toolName} was refused by the person who delegated this task (approval ${approval.id}). Do not retry it; continue without it or explain what you needed.`
  return [
    `The call to ${plan.toolName} needs approval before it runs, because ${plan.decision.effect === "approve" ? plan.decision.reason : "it is gated"}.`,
    `Approval ${approval.id} has been requested from the person who delegated this task.`,
    "Do other work, or wait, then call the tool again with exactly the same arguments. It runs once it is approved.",
  ].join(" ")
}

/** The front listener's handler. */
export function frontHandler(config: GateConfig) {
  const fetchFn = config.fetch ?? fetch
  const log = config.log ?? (() => {})
  const upstreamUrl = new URL(config.upstream)

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    // front proxies one literal path; anything else did not come from front's location.
    if (url.pathname !== upstreamUrl.pathname || url.search !== "") return json(403, { error: "forbidden" })
    if (!["GET", "POST", "DELETE"].includes(request.method)) return json(405, { error: "method not allowed" })

    const headers = pick(request.headers, PASS_REQUEST)
    if (request.method !== "POST") {
      const upstream = await fetchFn(upstreamUrl, { method: request.method, headers, redirect: "error" })
      return new Response(upstream.body, { status: upstream.status, headers: pick(upstream.headers, PASS_RESPONSE) })
    }

    const raw = await request.text()
    if (raw.length > MAX_REQUEST_BYTES) return json(413, { error: "request too large" })
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
    }
    // A batch could hide a gated call among others; the MCP client never sends one, so refuse it.
    if (Array.isArray(parsed)) return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batches are not accepted by the delegation gate." } })
    const message = parsed as Message
    const plan = planMessage(config.profile, message)

    if (plan.kind === "decide") {
      const { decision } = plan
      log({ event: "tool", tool: plan.toolName.slice(0, 200), schemaOnly: plan.schemaOnly, decision: decision.effect })
      if (decision.effect === "deny")
        return json(200, toolError(plan.id, `${plan.toolName} is not available to this delegated task (${decision.reason}).`))
      if (decision.effect === "approve") {
        let outcome
        try {
          outcome = config.approvals.check(plan.toolName, plan.args, decision.reason)
        } catch {
          return json(200, toolError(plan.id, "Too many calls are waiting for approval. Wait for answers before asking for more."))
        }
        if (!outcome.approved) {
          log({ event: "approval", id: outcome.approval.id, tool: plan.toolName.slice(0, 200), state: outcome.approval.state })
          return json(200, toolError(plan.id, approvalText(plan, outcome.approval)))
        }
        log({ event: "approval_used", tool: plan.toolName.slice(0, 200) })
      }
    }

    const upstream = await fetchFn(upstreamUrl, { method: "POST", headers, body: raw, redirect: "error" })
    const responseHeaders = pick(upstream.headers, PASS_RESPONSE)
    if (plan.kind !== "filter" || !upstream.ok) return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })

    const text = await upstream.text()
    if (text.length > MAX_FILTER_BYTES) return json(200, toolError(plan.id, "The tool list was too large for the delegation gate to check, so it was withheld."))
    const edit = (m: Message): Message => (m.id === plan.id && m.result !== undefined ? filterResult(config.profile, m, plan.what) : m)
    const contentType = upstream.headers.get("content-type") ?? ""
    if (contentType.includes("text/event-stream")) return new Response(rewriteSse(text, edit), { status: upstream.status, headers: responseHeaders })
    try {
      return new Response(JSON.stringify(edit(JSON.parse(text) as Message)), { status: upstream.status, headers: responseHeaders })
    } catch {
      return json(200, toolError(plan.id, "The delegation gate could not read the tool list, so it was withheld."))
    }
  }
}

function sameToken(given: string | null, expected: string): boolean {
  if (given === null || !given.startsWith("Bearer ")) return false
  const a = Buffer.from(given.slice(7))
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The admin listener's handler: GET /v1/approvals[?state=], POST /v1/approvals/<id> {decision}. */
export function adminHandler(config: GateConfig) {
  return async (request: Request): Promise<Response> => {
    if (!sameToken(request.headers.get("authorization"), config.adminToken)) return json(401, { error: "unauthorized" })
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/v1/health") return json(200, { ok: true })
    if (request.method === "GET" && url.pathname === "/v1/approvals") {
      const state = url.searchParams.get("state") ?? undefined
      const allowed = ["pending", "approved", "denied", "used", "expired"]
      if (state !== undefined && !allowed.includes(state)) return json(400, { error: "bad state" })
      return json(200, { approvals: config.approvals.list(state as never) })
    }
    const match = /^\/v1\/approvals\/(apr_[a-z0-9]{1,40})$/.exec(url.pathname)
    if (request.method === "POST" && match) {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return json(400, { error: "body must be JSON" })
      }
      const decision = (body as { decision?: unknown } | null)?.decision
      if (decision !== "approve" && decision !== "deny") return json(400, { error: 'decision must be "approve" or "deny"' })
      const updated = config.approvals.decide(match[1]!, decision)
      if (updated === undefined) return json(409, { error: "no pending approval with that id" })
      config.log?.({ event: "decided", id: updated.id, state: updated.state })
      return json(200, { approval: updated })
    }
    return json(404, { error: "not found" })
  }
}
