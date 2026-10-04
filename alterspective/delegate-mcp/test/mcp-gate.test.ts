// #104: the delegation gate for Keystone /mcp/dynamic (mcp-gate/src).
import { describe, expect, test } from "bun:test"
import { APPROVAL_TTL_MS, ApprovalStore } from "../mcp-gate/src/approvals.ts"
import { planMessage, rewriteSse } from "../mcp-gate/src/mcp.ts"
import { decide, parseProfile, toolRisk, type Profile } from "../mcp-gate/src/policy.ts"
import { adminHandler, frontHandler, type GateConfig } from "../mcp-gate/src/server.ts"

const UPSTREAM = "https://identity.example.test/mcp/dynamic"
const ADMIN = "a".repeat(40)
const TOKEN = "Bearer owner-token-test"

const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
const execute = (id: number, toolName: string, args: Record<string, unknown> = {}) => call(id, "execute-tool", { toolName, arguments: args })

type Seen = { url: string; method: string; headers: Headers; body?: string }

function gate(profile: Profile = {}, reply?: (body: unknown) => Response) {
  const seen: Seen[] = []
  const logs: Record<string, unknown>[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : undefined
    seen.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body })
    if (reply) return reply(body === undefined ? undefined : JSON.parse(body))
    const id = body === undefined ? null : (JSON.parse(body) as { id?: number }).id ?? null
    return Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ran" }] } })
  }) as typeof fetch
  const approvals = new ApprovalStore()
  const config: GateConfig = { upstream: UPSTREAM, profile, adminToken: ADMIN, approvals, fetch: fetchFn, log: (e) => logs.push(e) }
  const front = frontHandler(config)
  const admin = adminHandler(config)
  const post = (message: unknown, headers: Record<string, string> = {}) =>
    front(new Request("http://mcp-gate:8090/mcp/dynamic", { method: "POST", headers: { authorization: TOKEN, "content-type": "application/json", ...headers }, body: JSON.stringify(message) }))
  const adminCall = (path: string, init: RequestInit = {}) => admin(new Request(`http://mcp-gate-admin:8091${path}`, { ...init, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", ...(init.headers ?? {}) } }))
  return { seen, logs, approvals, post, front, adminCall }
}

const text = async (res: Response) => ((await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result

describe("policy (CAS field names, CAS matcher)", () => {
  test("default: reads run, anything that may change, send or run code waits for approval", () => {
    expect(decide({}, "github__get_issue").effect).toBe("allow")
    expect(decide({}, "rag__rag_search").effect).toBe("allow")
    expect(decide({}, "m365__send-mail")).toEqual({ effect: "approve", reason: "it can send data out" })
    expect(decide({}, "monday__execute_code")).toEqual({ effect: "approve", reason: "it can run code or commands" })
    expect(decide({}, "github__create_pull_request")).toEqual({ effect: "approve", reason: "it can change something" })
    // Fail closed like CAS: no read verb means it is treated as a change.
    expect(decide({}, "acme__frobnicate").effect).toBe("approve")
  })

  test("a profile narrows: denied beats allowed, allowed limits, approvals: listed only asks for listed tools", () => {
    const profile: Profile = { allowedToolPatterns: ["github__*", "rag__*"], deniedToolPatterns: ["github__delete_*"], approvalRequiredToolPatterns: ["github__merge_*"], approvals: "listed" }
    expect(decide(profile, "m365__list-mail").effect).toBe("deny")
    expect(decide(profile, "github__delete_branch").effect).toBe("deny")
    expect(decide(profile, "github__merge_pull_request").effect).toBe("approve")
    expect(decide(profile, "github__create_issue").effect).toBe("allow")
  })

  test("a damaged profile fails closed instead of falling back to everything", () => {
    expect(() => parseProfile("{")).toThrow()
    expect(() => parseProfile('{"allowedTools": ["x"]}')).toThrow(/unknown field/)
    expect(() => parseProfile('{"deniedToolPatterns": ["a b"]}')).toThrow()
    expect(() => parseProfile('{"approvals": "never"}')).toThrow()
    expect(parseProfile("")).toEqual({})
  })

  test("risk words match on the upstream tool name, not the namespace", () => {
    expect(toolRisk("mail__list_messages")).toBeUndefined()
    expect(toolRisk("x__post_message")).toBe("it can send data out")
  })
})

describe("approvals", () => {
  test("one approval runs exactly the same call once", () => {
    const store = new ApprovalStore()
    const first = store.check("m365__send-mail", { to: "a@b.test", body: "hi" }, "r")
    expect(first.approved).toBe(false)
    const id = first.approved ? "" : first.approval.id
    // The same call before a decision returns the same approval, not a new one.
    const again = store.check("m365__send-mail", { body: "hi", to: "a@b.test" }, "r")
    expect(again.approved === false && again.approval.id).toBe(id)
    expect(store.decide(id, "approve")?.state).toBe("approved")
    expect(store.check("m365__send-mail", { to: "a@b.test", body: "other" }, "r").approved).toBe(false)
    expect(store.check("m365__send-mail", { to: "a@b.test", body: "hi" }, "r").approved).toBe(true)
    const third = store.check("m365__send-mail", { to: "a@b.test", body: "hi" }, "r")
    expect(third.approved).toBe(false)
  })

  test("a refusal stands for the window; an unused approval expires", () => {
    let now = 1_000
    const store = new ApprovalStore(() => now)
    const asked = store.check("t__send", { a: 1 }, "r")
    const id = asked.approved ? "" : asked.approval.id
    store.decide(id, "deny")
    const retry = store.check("t__send", { a: 1 }, "r")
    expect(retry.approved === false && retry.approval.state).toBe("denied")
    const other = store.check("t__send", { a: 2 }, "r")
    const otherId = other.approved ? "" : other.approval.id
    store.decide(otherId, "approve")
    now += APPROVAL_TTL_MS + 1
    expect(store.check("t__send", { a: 2 }, "r").approved).toBe(false)
    expect(store.list("expired").some((a) => a.id === otherId)).toBe(true)
  })
})

describe("planning and filtering", () => {
  test("execute-tool and get-tool-schema are decided on arguments.toolName", () => {
    const plan = planMessage({ deniedToolPatterns: ["m365__*"] }, execute(1, "m365__send-mail"))
    expect(plan.kind === "decide" && plan.decision.effect).toBe("deny")
    const schema = planMessage({}, call(2, "get-tool-schema", { toolName: "m365__send-mail" }))
    // Reading a schema changes nothing: a visible risky tool's schema is allowed.
    expect(schema.kind === "decide" && schema.decision.effect).toBe("allow")
  })

  test("an SSE response is rewritten event by event", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"tools":[]}}\n\n'
    const out = rewriteSse(body, (m) => ({ ...m, result: { edited: true } }))
    expect(out).toContain('"edited":true')
    expect(out).toContain("event: message")
  })
})

describe("front listener", () => {
  test("a read runs: forwarded to the fixed upstream with the owner's token, other headers dropped", async () => {
    const g = gate()
    const res = await g.post(execute(1, "github__get_issue", { n: 1 }), { cookie: "x=1", "x-forwarded-for": "1.2.3.4", "mcp-session-id": "s1" })
    expect((await text(res)).content[0]!.text).toBe("ran")
    expect(g.seen).toHaveLength(1)
    expect(g.seen[0]!.url).toBe(UPSTREAM)
    expect(g.seen[0]!.headers.get("authorization")).toBe(TOKEN)
    expect(g.seen[0]!.headers.get("mcp-session-id")).toBe("s1")
    expect(g.seen[0]!.headers.get("cookie")).toBeNull()
    expect(g.seen[0]!.headers.get("x-forwarded-for")).toBeNull()
  })

  test("a denied tool never reaches Keystone; the model gets a tool error", async () => {
    const g = gate({ deniedToolPatterns: ["m365__*"] })
    const result = await text(await g.post(execute(1, "m365__list-mail")))
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("not available to this delegated task")
    expect(g.seen).toHaveLength(0)
  })

  test("a risky call waits for approval, runs once after the admin approves, and is logged without arguments", async () => {
    const g = gate()
    const args = { to: "someone@example.test", body: "secret text" }
    const first = await text(await g.post(execute(1, "m365__send-mail", args)))
    expect(first.isError).toBe(true)
    expect(g.seen).toHaveLength(0)
    const id = /apr_[a-z0-9]+/.exec(first.content[0]!.text)![0]
    const listed = (await (await g.adminCall("/v1/approvals?state=pending")).json()) as { approvals: { id: string; toolName: string }[] }
    expect(listed.approvals.map((a) => a.id)).toEqual([id])
    expect((await g.adminCall(`/v1/approvals/${id}`, { method: "POST", body: JSON.stringify({ decision: "approve" }) })).status).toBe(200)
    expect((await text(await g.post(execute(2, "m365__send-mail", args)))).content[0]!.text).toBe("ran")
    expect(g.seen).toHaveLength(1)
    expect(JSON.stringify(g.logs)).not.toContain("secret text")
    expect(JSON.stringify(g.logs)).not.toContain("owner-token-test")
  })

  test("search-tools results lose hidden tools and say so", async () => {
    const search = { tools: [{ name: "github__get_issue" }, { name: "m365__send-mail" }], services: [{ connectionName: "m365", tools: ["m365__send-mail"], toolCount: 1 }, { connectionName: "github", tools: ["github__get_issue"], toolCount: 1 }], totalMatches: 2 }
    const g = gate({ deniedToolPatterns: ["m365__*"] }, (body) =>
      new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: (body as { id: number }).id, result: { content: [{ type: "text", text: JSON.stringify(search) }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } }),
    )
    const res = await g.post(call(5, "search-tools", { query: "mail" }))
    const data = (await res.text()).split("\n").find((l) => l.startsWith("data:"))!.slice(6)
    const inner = JSON.parse((JSON.parse(data) as { result: { content: { text: string }[] } }).result.content[0]!.text)
    expect(inner.tools.map((t: { name: string }) => t.name)).toEqual(["github__get_issue"])
    expect(inner.services.map((s: { connectionName: string }) => s.connectionName)).toEqual(["github"])
    expect(inner.hiddenByDelegationProfile).toBe(1)
    expect(inner.totalMatches).toBeNull()
  })

  test("batches, other paths and query strings are refused", async () => {
    const g = gate()
    expect((await g.post([execute(1, "github__get_issue")])).status).toBe(400)
    expect((await g.front(new Request("http://mcp-gate:8090/api/mcp", { method: "POST", body: "{}" }))).status).toBe(403)
    expect((await g.front(new Request("http://mcp-gate:8090/mcp/dynamic?x=1", { method: "POST", body: "{}" }))).status).toBe(403)
    expect(g.seen).toHaveLength(0)
  })
})

describe("admin listener", () => {
  test("needs the admin token; a decision needs a pending approval", async () => {
    const g = gate()
    const admin = adminHandler({ upstream: UPSTREAM, profile: {}, adminToken: ADMIN, approvals: g.approvals })
    expect((await admin(new Request("http://x/v1/approvals"))).status).toBe(401)
    expect((await admin(new Request("http://x/v1/approvals", { headers: { authorization: `Bearer ${"b".repeat(40)}` } }))).status).toBe(401)
    expect((await g.adminCall("/v1/approvals/apr_missing", { method: "POST", body: JSON.stringify({ decision: "approve" }) })).status).toBe(409)
    expect((await g.adminCall("/v1/approvals/apr_x", { method: "POST", body: JSON.stringify({ decision: "maybe" }) })).status).toBe(400)
  })
})
