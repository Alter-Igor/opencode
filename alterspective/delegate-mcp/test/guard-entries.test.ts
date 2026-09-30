// T2.1 — profile-time MCP allowlist (technical-design §3.2). Every refusal row was run RED
// against an allow-everything stub before the validator was written (evidence in the report).
import { describe, expect, test } from "bun:test"
import { KS_PATH, validateEntries } from "../src/guard/entries.ts"
import { defaultConfig, mcpAllowPolicy } from "../src/shared/config.ts"
import type { McpEntry } from "../src/shared/contracts.ts"

const ORIGIN = "https://identity.alterspective.com.au"
const good = (url = `${ORIGIN}/mcp/dynamic`): McpEntry => ({ type: "remote", url })

// Loose on purpose: refusal rows must be able to carry shapes the typed contract forbids.
type Row = [label: string, name: string, entry: unknown]

const refused: Row[] = [
  ["direct service host", "ks-rag", good("https://rag.alterspective.com.au/mcp")],
  ["look-alike host (suffix)", "ks-evil", good("https://identity.alterspective.com.au.evil.com/mcp/dynamic")],
  ["look-alike host (prefix)", "ks-evil", good("https://evilidentity.alterspective.com.au/mcp/dynamic")],
  ["sub-domain of Keystone", "ks-evil", good("https://x.identity.alterspective.com.au/mcp/dynamic")],
  ["http scheme", "ks-delegate", good("http://identity.alterspective.com.au/mcp/dynamic")],
  ["explicit non-default port", "ks-delegate", good("https://identity.alterspective.com.au:8443/mcp/dynamic")],
  ["/api/mcp path", "ks-delegate", good(`${ORIGIN}/api/mcp`)],
  ["/mcp/c/../x traversal", "ks-delegate", good(`${ORIGIN}/mcp/c/../x`)],
  ["%2e%2e traversal", "ks-delegate", good(`${ORIGIN}/mcp/c/%2e%2e/admin`)],
  ["encoded slash in connection id", "ks-delegate", good(`${ORIGIN}/mcp/c/abc%2Fdef`)],
  ["trailing slash", "ks-delegate", good(`${ORIGIN}/mcp/dynamic/`)],
  ["deeper path under a connection", "ks-delegate", good(`${ORIGIN}/mcp/c/abc/extra`)],
  ["userinfo", "ks-delegate", good("https://user:pw@identity.alterspective.com.au/mcp/dynamic")],
  ["query string", "ks-delegate", good(`${ORIGIN}/mcp/dynamic?token=x`)],
  ["empty query marker", "ks-delegate", good(`${ORIGIN}/mcp/dynamic?`)],
  ["fragment", "ks-delegate", good(`${ORIGIN}/mcp/dynamic#x`)],
  ["unparseable URL", "ks-delegate", good("not a url")],
  ["missing URL", "ks-delegate", { type: "remote" }],
  ["header present", "ks-delegate", { ...good(), headers: { authorization: "Bearer shared" } }],
  ["empty headers object", "ks-delegate", { ...good(), headers: {} }],
  ["oauth.clientSecret", "ks-delegate", { ...good(), oauth: { clientId: "c", clientSecret: "s" } }],
  ["oauth.redirectUri", "ks-delegate", { ...good(), oauth: { redirectUri: "http://127.0.0.1:1/cb" } }],
  ["oauth.callbackPort", "ks-delegate", { ...good(), oauth: { callbackPort: 1 } }],
  ["oauth:false", "ks-delegate", { ...good(), oauth: false }],
  ["oauth:null", "ks-delegate", { ...good(), oauth: null }],
  ["oauth scope not a string", "ks-delegate", { ...good(), oauth: { scope: 1 } }],
  ["local type", "ks-delegate", { type: "local", command: ["node", "x.js"] }],
  ["missing type", "ks-delegate", { url: `${ORIGIN}/mcp/dynamic` }],
  ["unknown extra key", "ks-delegate", { ...good(), command: ["sh"] }],
  ["entry not an object", "ks-delegate", "https://identity.alterspective.com.au/mcp/dynamic"],
  ["wrong name (no prefix)", "delegate", good()],
  ["wrong name (upper case)", "ks-Delegate", good()],
  ["wrong name (underscore)", "ks_delegate", good()],
  ["wrong name (bare prefix)", "ks-", good()],
  ["disabled entry still validated", "ks-rag", { ...good("https://rag.alterspective.com.au/mcp"), enabled: false }],
]

const accepted: Row[] = [
  ["dynamic", "ks-delegate", good()],
  ["pinned connection", "ks-abc123", good(`${ORIGIN}/mcp/c/abc_DEF-123`)],
  ["oauth scope + clientId", "ks-delegate", { ...good(), oauth: { scope: "mcp:connection", clientId: "c1" } }],
  ["disabled good entry", "ks-delegate", { ...good(), enabled: false }],
  ["timeout", "ks-delegate", { ...good(), timeout: 5000 }],
  ["default port spelled out", "ks-delegate", good("https://identity.alterspective.com.au:443/mcp/dynamic")],
  ["upper-case host normalised", "ks-delegate", good("https://IDENTITY.alterspective.com.au/mcp/dynamic")],
]

const run = (name: string, entry: unknown) => validateEntries({ [name]: entry as McpEntry }, ORIGIN)

describe("validateEntries refuses", () => {
  for (const [label, name, entry] of refused) {
    test(label, () => {
      const verdict = run(name, entry)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) {
        expect(verdict.code).toBe("policy_violation")
        expect(verdict.reason).toContain(name)
      }
    })
  }

  test("one bad entry among good ones", () => {
    const verdict = validateEntries({ "ks-delegate": good(), "ks-rag": good("https://rag.alterspective.com.au/mcp") }, ORIGIN)
    expect(verdict.ok).toBe(false)
  })

  test("refuses everything when the configured origin is not https", () => {
    expect(validateEntries({ "ks-delegate": good("http://identity.alterspective.com.au/mcp/dynamic") }, "http://identity.alterspective.com.au").ok).toBe(false)
  })
})

describe("validateEntries accepts", () => {
  for (const [label, name, entry] of accepted) {
    test(label, () => expect(run(name, entry)).toEqual({ ok: true }))
  }

  test("no entries at all", () => expect(validateEntries({}, ORIGIN)).toEqual({ ok: true }))
})

describe("consistency with the fork patch policy", () => {
  test("path pattern equals the OPENCODE_MCP_ALLOW policy the box runs with", () => {
    const policy = JSON.parse(mcpAllowPolicy(defaultConfig({}))) as { remote: Array<{ origin: string; path: string }> }
    expect(policy.remote).toEqual([{ origin: ORIGIN, path: KS_PATH }])
  })
})

describe("createGuard", () => {
  test("binds validateEntries to config.keystoneOrigin", async () => {
    const { createGuard } = await import("../src/guard/index.ts")
    const guard = createGuard(defaultConfig({}))
    expect(guard.validateEntries({ "ks-delegate": good() })).toEqual({ ok: true })
    expect(guard.validateEntries({ "ks-rag": good("https://rag.alterspective.com.au/mcp") }).ok).toBe(false)
    expect(guard.checkPermissionReply("always").ok).toBe(false)
  })
})
