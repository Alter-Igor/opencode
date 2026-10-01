// T2.1 — profile-time MCP allowlist (technical-design §3.2). Every refusal row was run RED
// against an allow-everything stub before the validator was written (evidence in the report).
// R4-01: an entry is ks-<id> → exactly /mcp/c/<id>, with <id> in the chosen Keystone set; the
// /mcp/dynamic rows were run RED against the HEAD code (which accepted them) before the change.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { validateEntries } from "../src/guard/entries.ts"
import { defaultConfig } from "../src/shared/config.ts"
import type { McpEntry } from "../src/shared/contracts.ts"
import { saveKeystoneSet } from "../src/shared/keystone.ts"

const ORIGIN = "https://identity.alterspective.com.au"
const CHOSEN = ["rag-global", "github", "seqlogs"]
const good = (url = `${ORIGIN}/mcp/c/github`): McpEntry => ({ type: "remote", url })

// Loose on purpose: refusal rows must be able to carry shapes the typed contract forbids.
type Row = [label: string, name: string, entry: unknown]

const refused: Row[] = [
  // R4-01: the dynamic relay and anything outside the chosen set.
  ["/mcp/dynamic (every service on the account)", "ks-delegate", good(`${ORIGIN}/mcp/dynamic`)],
  ["/mcp/dynamic under a chosen name", "ks-github", good(`${ORIGIN}/mcp/dynamic`)],
  ["a connection outside the chosen set", "ks-m365", good(`${ORIGIN}/mcp/c/m365`)],
  ["name and path for different chosen connections", "ks-github", good(`${ORIGIN}/mcp/c/rag-global`)],
  ["upper-case connection id in the path", "ks-github", good(`${ORIGIN}/mcp/c/GitHub`)],
  ["encoded connection id", "ks-github", good(`${ORIGIN}/mcp/c/git%68ub`)],
  ["direct service host", "ks-github", good("https://rag.alterspective.com.au/mcp")],
  ["look-alike host (suffix)", "ks-github", good("https://identity.alterspective.com.au.evil.com/mcp/c/github")],
  ["look-alike host (prefix)", "ks-github", good("https://evilidentity.alterspective.com.au/mcp/c/github")],
  ["sub-domain of Keystone", "ks-github", good("https://x.identity.alterspective.com.au/mcp/c/github")],
  ["http scheme", "ks-github", good("http://identity.alterspective.com.au/mcp/c/github")],
  ["explicit non-default port", "ks-github", good("https://identity.alterspective.com.au:8443/mcp/c/github")],
  ["/api/mcp path", "ks-github", good(`${ORIGIN}/api/mcp`)],
  ["/mcp/c/../x traversal", "ks-github", good(`${ORIGIN}/mcp/c/../dynamic`)],
  ["%2e%2e traversal", "ks-github", good(`${ORIGIN}/mcp/c/%2e%2e/admin`)],
  ["traversal that lands on another id", "ks-github", good(`${ORIGIN}/mcp/c/github/../m365`)],
  ["encoded slash in connection id", "ks-github", good(`${ORIGIN}/mcp/c/github%2F..%2Fm365`)],
  ["trailing slash", "ks-github", good(`${ORIGIN}/mcp/c/github/`)],
  ["deeper path under a connection", "ks-github", good(`${ORIGIN}/mcp/c/github/extra`)],
  ["userinfo", "ks-github", good("https://user:pw@identity.alterspective.com.au/mcp/c/github")],
  ["query string", "ks-github", good(`${ORIGIN}/mcp/c/github?token=x`)],
  ["empty query marker", "ks-github", good(`${ORIGIN}/mcp/c/github?`)],
  ["fragment", "ks-github", good(`${ORIGIN}/mcp/c/github#x`)],
  ["unparseable URL", "ks-github", good("not a url")],
  ["missing URL", "ks-github", { type: "remote" }],
  ["header present", "ks-github", { ...good(), headers: { authorization: "Bearer shared" } }],
  ["empty headers object", "ks-github", { ...good(), headers: {} }],
  ["oauth.clientSecret", "ks-github", { ...good(), oauth: { clientId: "c", clientSecret: "s" } }],
  ["oauth.redirectUri", "ks-github", { ...good(), oauth: { redirectUri: "http://127.0.0.1:1/cb" } }],
  ["oauth.callbackPort", "ks-github", { ...good(), oauth: { callbackPort: 1 } }],
  ["oauth:false", "ks-github", { ...good(), oauth: false }],
  ["oauth:null", "ks-github", { ...good(), oauth: null }],
  ["oauth scope not a string", "ks-github", { ...good(), oauth: { scope: 1 } }],
  ["local type", "ks-github", { type: "local", command: ["node", "x.js"] }],
  ["missing type", "ks-github", { url: `${ORIGIN}/mcp/c/github` }],
  ["unknown extra key", "ks-github", { ...good(), command: ["sh"] }],
  ["entry not an object", "ks-github", "https://identity.alterspective.com.au/mcp/c/github"],
  ["wrong name (no prefix)", "github", good()],
  ["wrong name (upper case)", "ks-GitHub", good()],
  ["wrong name (underscore)", "ks_github", good()],
  ["wrong name (bare prefix)", "ks-", good()],
  ["wrong name (leading dash in id)", "ks--github", good()],
  ["disabled entry still validated", "ks-github", { ...good(`${ORIGIN}/mcp/dynamic`), enabled: false }],
]

const accepted: Row[] = [
  ["a chosen connection", "ks-github", good()],
  ["another chosen connection", "ks-rag-global", good(`${ORIGIN}/mcp/c/rag-global`)],
  ["oauth scope + clientId", "ks-github", { ...good(), oauth: { scope: "mcp:connection", clientId: "c1" } }],
  ["disabled good entry", "ks-github", { ...good(), enabled: false }],
  ["timeout", "ks-github", { ...good(), timeout: 5000 }],
  ["default port spelled out", "ks-github", good("https://identity.alterspective.com.au:443/mcp/c/github")],
  ["upper-case host normalised", "ks-github", good("https://IDENTITY.alterspective.com.au/mcp/c/github")],
]

const run = (name: string, entry: unknown) => validateEntries({ [name]: entry as McpEntry }, ORIGIN, CHOSEN)

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
    const verdict = validateEntries({ "ks-github": good(), "ks-m365": good(`${ORIGIN}/mcp/c/m365`) }, ORIGIN, CHOSEN)
    expect(verdict.ok).toBe(false)
  })

  test("refuses everything when the configured origin is not https", () => {
    expect(validateEntries({ "ks-github": good("http://identity.alterspective.com.au/mcp/c/github") }, "http://identity.alterspective.com.au", CHOSEN).ok).toBe(false)
  })

  test("an empty chosen set refuses every entry", () => {
    expect(validateEntries({ "ks-github": good() }, ORIGIN, []).ok).toBe(false)
  })
})

describe("validateEntries accepts", () => {
  for (const [label, name, entry] of accepted) {
    test(label, () => expect(run(name, entry)).toEqual({ ok: true }))
  }

  test("no entries at all", () => expect(validateEntries({}, ORIGIN, CHOSEN)).toEqual({ ok: true }))
})

describe("createGuard", () => {
  test("binds validateEntries to config.keystoneOrigin and the Keystone set in force (default, then saved)", async () => {
    const { createGuard } = await import("../src/guard/index.ts")
    const home = mkdtempSync(path.join(os.tmpdir(), "ocd-guard-"))
    const guard = createGuard({ ...defaultConfig({}), home })
    expect(guard.validateEntries({ "ks-github": good() })).toEqual({ ok: true })
    expect(guard.validateEntries({ "ks-delegate": good(`${ORIGIN}/mcp/dynamic`) }).ok).toBe(false)
    saveKeystoneSet(home, ["rag-global"])
    // Read on every check: another bridge may have changed the set.
    expect(guard.validateEntries({ "ks-github": good() }).ok).toBe(false)
    expect(guard.validateEntries({ "ks-rag-global": good(`${ORIGIN}/mcp/c/rag-global`) })).toEqual({ ok: true })
    expect(guard.checkPermissionReply("always").ok).toBe(false)
  })
})
