import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { McpAuth } from "../../src/mcp/auth"
import { McpOAuthProvider, refreshSingleFlightFetch } from "../../src/mcp/oauth-provider"
import { testEffect } from "../lib/effect"

const authTest = testEffect(LayerNode.compile(McpAuth.node))

// Token endpoint that rotates refresh tokens and, like Keystone, revokes the whole family
// when a rotated-out refresh token is presented again.
function rotatingTokenServer() {
  const state = { grants: 0, reuse: 0, current: "rt-1", revoked: false, generation: 1, issued: new Set<string>() }
  const http = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = new URLSearchParams(await request.text())
      if (body.get("grant_type") !== "refresh_token") return new Response("bad", { status: 400 })
      state.grants++
      await Bun.sleep(50)
      if (state.revoked || body.get("refresh_token") !== state.current) {
        state.reuse++
        state.revoked = true
        return Response.json({ error: "invalid_grant", error_description: "family revoked" }, { status: 400 })
      }
      state.generation++
      state.current = `rt-${state.generation}`
      state.issued.add(`Bearer at-${state.generation}`)
      return Response.json({
        access_token: `at-${state.generation}`,
        token_type: "Bearer",
        refresh_token: state.current,
        expires_in: 3600,
      })
    },
  })
  return { state, tokenUrl: new URL("/token", http.url), stop: () => http.stop(true) }
}

const refresh = (tokenUrl: URL, refreshToken: string) =>
  refreshAuthorization(tokenUrl.origin, {
    metadata: {
      issuer: tokenUrl.origin,
      authorization_endpoint: `${tokenUrl.origin}/authorize`,
      token_endpoint: tokenUrl.toString(),
      response_types_supported: ["code"],
    },
    clientInformation: { client_id: "opencode" },
    refreshToken,
    fetchFn: refreshSingleFlightFetch,
  })

test("concurrent refreshes with the same refresh token make one network grant", async () => {
  const server = rotatingTokenServer()
  try {
    const results = await Promise.all([refresh(server.tokenUrl, "rt-1"), refresh(server.tokenUrl, "rt-1")])
    expect(server.state.grants).toBe(1)
    expect(results[0]).toEqual(results[1])
    expect(results[0].refresh_token).toBe("rt-2")

    // A caller that read rt-1 before it rotated gets the same result, not a reuse.
    const late = await refresh(server.tokenUrl, "rt-1")
    expect(late.refresh_token).toBe("rt-2")
    expect(server.state.grants).toBe(1)

    // The rotated token is a new key and refreshes normally.
    const next = await refresh(server.tokenUrl, "rt-2")
    expect(next.refresh_token).toBe("rt-3")
    expect(server.state.grants).toBe(2)
    expect(server.state.reuse).toBe(0)
  } finally {
    server.stop()
  }
})

test("non-refresh requests pass straight through", async () => {
  let calls = 0
  const http = Bun.serve({
    port: 0,
    fetch() {
      calls++
      return Response.json({ calls })
    },
  })
  try {
    const url = new URL("/token", http.url)
    const body = () => new URLSearchParams({ grant_type: "authorization_code", code: "c" })
    await Promise.all([
      refreshSingleFlightFetch(url, { method: "POST", body: body() }),
      refreshSingleFlightFetch(url, { method: "POST", body: body() }),
      refreshSingleFlightFetch(url),
    ])
    expect(calls).toBe(3)
  } finally {
    http.stop(true)
  }
})

// Full SDK path: two clients for the same MCP entry, sharing one stored token family,
// both hit 401 at once and refresh through McpOAuthProvider + the transport fetch.
authTest.live("two clients sharing a token family refresh once through the SDK", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const server = yield* Effect.acquireRelease(Effect.promise(protectedMcpServer), (s) => Effect.promise(s.stop))
    yield* auth.set(
      "ks-shared",
      {
        tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() / 1000 - 10 },
        clientInfo: { clientId: "opencode" },
      },
      server.url,
    )

    const connect = async () => {
      const provider = new McpOAuthProvider("ks-shared", server.url, {}, { onRedirect: async () => {} }, auth)
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        authProvider: provider,
        fetch: refreshSingleFlightFetch,
      })
      const client = new Client({ name: "test", version: "1.0.0" })
      await client.connect(transport)
      await client.close()
    }
    yield* Effect.promise(() => Promise.all([connect(), connect()]))

    // The invariant Keystone needs: no refresh token is ever presented twice. Usually both
    // clients share one grant; if the second client reads the rotated token first it makes a
    // legitimate grant with that new token, which is still not a reuse.
    expect(server.tokens.state.reuse).toBe(0)
    expect(server.tokens.state.grants).toBeLessThanOrEqual(2)
    expect((yield* auth.get("ks-shared"))?.tokens?.refreshToken).toBe(server.tokens.state.current)
  }),
)

async function protectedMcpServer() {
  const tokens = rotatingTokenServer()
  const http = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const origin = url.origin
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: tokens.tokenUrl.toString(),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        })
      }
      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 })
      if (request.method === "GET") return new Response(null, { status: 405 })
      // Access tokens stay valid after rotation; only a reused refresh token revokes the family.
      const valid = !tokens.state.revoked && tokens.state.issued.has(request.headers.get("authorization") ?? "")
      if (!valid) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` },
        })
      }
      return (await mcpSession()).handleRequest(request)
    },
  })
  return {
    tokens,
    url: new URL("/mcp", http.url).toString(),
    stop: async () => {
      http.stop(true)
      tokens.stop()
    },
  }
}

// Stateless per-request MCP server so each client gets its own session.
async function mcpSession() {
  const protocol = new Server({ name: "protected", version: "1.0.0" }, { capabilities: { tools: {} } })
  protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [] }))
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await protocol.connect(transport)
  return transport
}
