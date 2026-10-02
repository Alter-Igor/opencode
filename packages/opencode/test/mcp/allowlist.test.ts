import { describe, expect, test } from "bun:test"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { McpAllow } from "../../src/mcp/allowlist"

const POLICY = JSON.stringify({
  remote: [{ origin: "https://identity.alterspective.com.au", path: "^/mcp/(dynamic|c/[A-Za-z0-9_-]+)$" }],
})

const remote = (url: string, extra: Partial<ConfigMCPV1.Remote> = {}): ConfigMCPV1.Info => ({
  type: "remote",
  url,
  ...extra,
})

const check = (config: ConfigMCPV1.Info, env: string | undefined = POLICY) => McpAllow.check("ks-test", config, env)

function expectRefused(config: ConfigMCPV1.Info, reason: RegExp, env?: string) {
  const result = check(config, env)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.reason).toMatch(reason)
}

describe("McpAllow.check with a policy", () => {
  test("allows the Keystone dynamic endpoint", () => {
    expect(check(remote("https://identity.alterspective.com.au/mcp/dynamic"))).toEqual({ ok: true })
  })

  test("allows a pinned Keystone connection with scope and clientId", () => {
    const config = remote("https://identity.alterspective.com.au/mcp/c/rag-global", {
      oauth: { scope: "mcp", clientId: "opencode" },
    })
    expect(check(config)).toEqual({ ok: true })
  })

  test("refuses a direct service host", () => {
    expectRefused(remote("https://rag.alterspective.com.au/mcp"), /not an allowed MCP URL/)
  })

  test("refuses a look-alike host that starts with the allowed origin", () => {
    expectRefused(remote("https://identity.alterspective.com.au.evil.com/mcp/dynamic"), /not an allowed MCP URL/)
  })

  test("refuses the http scheme", () => {
    expectRefused(remote("http://identity.alterspective.com.au/mcp/dynamic"), /not an allowed MCP URL/)
  })

  test("refuses a non-matching path", () => {
    expectRefused(remote("https://identity.alterspective.com.au/api/mcp"), /not an allowed MCP URL/)
  })

  test("refuses path traversal out of /mcp/c/", () => {
    expectRefused(remote("https://identity.alterspective.com.au/mcp/c/../x"), /not an allowed MCP URL/)
    expectRefused(remote("https://identity.alterspective.com.au/mcp/c/%2e%2e/dynamic/x"), /not an allowed MCP URL/)
  })

  test("refuses static headers", () => {
    const config = remote("https://identity.alterspective.com.au/mcp/dynamic", { headers: { Authorization: "x" } })
    expectRefused(config, /headers/)
  })

  test("refuses oauth.clientSecret, redirectUri and callbackPort", () => {
    const url = "https://identity.alterspective.com.au/mcp/dynamic"
    expectRefused(remote(url, { oauth: { clientSecret: "s" } }), /oauth\.clientSecret/)
    expectRefused(remote(url, { oauth: { redirectUri: "http://127.0.0.1:1/cb" } }), /oauth\.redirectUri/)
    expectRefused(remote(url, { oauth: { callbackPort: 1234 } }), /oauth\.callbackPort/)
  })

  // #67: the delegate box sets oauth:false; the Authorization header is added outside the box.
  test("allows oauth:false on an allowed remote URL", () => {
    expect(check(remote("https://identity.alterspective.com.au/mcp/dynamic", { oauth: false }))).toEqual({ ok: true })
    expect(check(remote("https://identity.alterspective.com.au/mcp/c/rag-global", { oauth: false }))).toEqual({
      ok: true,
    })
  })

  test("oauth:false does not relax any other rule", () => {
    const off = { oauth: false } as const
    expectRefused(remote("https://rag.alterspective.com.au/mcp", off), /not an allowed MCP URL/)
    expectRefused(remote("https://identity.alterspective.com.au.evil.com/mcp/dynamic", off), /not an allowed MCP URL/)
    expectRefused(remote("http://identity.alterspective.com.au/mcp/dynamic", off), /not an allowed MCP URL/)
    expectRefused(remote("https://identity.alterspective.com.au/mcp/c/../x", off), /not an allowed MCP URL/)
    expectRefused(remote("https://identity.alterspective.com.au/mcp/dynamic?x=1", off), /query or fragment/)
    expectRefused(remote("https://user:pw@identity.alterspective.com.au/mcp/dynamic", off), /credentials/)
    expectRefused(remote("not a url", off), /does not parse/)
    expectRefused(
      remote("https://identity.alterspective.com.au/mcp/dynamic", { ...off, headers: { Authorization: "x" } }),
      /headers/,
    )
    expectRefused(remote("https://identity.alterspective.com.au/mcp/dynamic", off), /not valid JSON/, "{remote:[")
  })

  test("refuses local servers", () => {
    expectRefused({ type: "local", command: ["node", "server.js"] }, /not a remote MCP server/)
  })

  test("refuses a query string, a fragment and userinfo", () => {
    expectRefused(remote("https://identity.alterspective.com.au/mcp/dynamic?x=1"), /query or fragment/)
    expectRefused(remote("https://identity.alterspective.com.au/mcp/dynamic?"), /query or fragment/)
    expectRefused(remote("https://identity.alterspective.com.au/mcp/dynamic#frag"), /query or fragment/)
    expectRefused(remote("https://user:pw@identity.alterspective.com.au/mcp/dynamic"), /credentials/)
  })

  test("refuses a URL that does not parse", () => {
    expectRefused(remote("not a url"), /does not parse/)
  })
})

describe("McpAllow.check policy loading", () => {
  const good = remote("https://identity.alterspective.com.au/mcp/dynamic")

  test("fails closed on malformed JSON", () => {
    expectRefused(good, /not valid JSON/, "{remote:[")
  })

  test("fails closed on the wrong shape", () => {
    expectRefused(
      good,
      /not valid JSON/,
      JSON.stringify({ remote: [{ origin: "https://identity.alterspective.com.au" }] }),
    )
    expectRefused(good, /not valid JSON/, JSON.stringify(["https://identity.alterspective.com.au"]))
  })

  test("fails closed on an invalid path pattern", () => {
    expectRefused(good, /invalid path pattern/, JSON.stringify({ remote: [{ origin: "https://x", path: "(" }] }))
  })

  test("an empty remote list refuses everything", () => {
    expectRefused(good, /not an allowed MCP URL/, JSON.stringify({ remote: [] }))
  })

  test("blank env allows everything", () => {
    expect(check({ type: "local", command: ["node"] }, "")).toEqual({ ok: true })
    expect(check(remote("https://rag.alterspective.com.au/mcp", { oauth: false }), "")).toEqual({ ok: true })
    expect(check(remote("http://anything/x?y#z", { headers: { a: "b" } }), "   ")).toEqual({ ok: true })
  })

  test("reads OPENCODE_MCP_ALLOW from the environment; unset allows everything", () => {
    const previous = process.env[McpAllow.ENV]
    try {
      process.env[McpAllow.ENV] = POLICY
      expect(McpAllow.check("x", remote("https://rag.alterspective.com.au/mcp")).ok).toBe(false)
      delete process.env[McpAllow.ENV]
      expect(McpAllow.check("x", remote("https://rag.alterspective.com.au/mcp")).ok).toBe(true)
    } finally {
      if (previous === undefined) delete process.env[McpAllow.ENV]
      else process.env[McpAllow.ENV] = previous
    }
  })
})
