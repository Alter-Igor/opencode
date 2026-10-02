import fs from "node:fs"
import path from "node:path"
import { expect, spyOn } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { McpAllow } from "../../src/mcp/allowlist"
import { MCP } from "../../src/mcp/index"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import * as OAuthProvider from "../../src/mcp/oauth-provider"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))

// Plain MCP server that records every request it receives. `stateless`: a new server per
// request, so more than one client (connect, then startAuth) can initialize.
function recordingServer(options: { stateless?: boolean } = {}) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const session = async () => {
        const protocol = new Server({ name: "allowlist", version: "1.0.0" }, { capabilities: { tools: {} } })
        protocol.setRequestHandler(ListToolsRequestSchema, () =>
          Promise.resolve({ tools: [{ name: "probe", inputSchema: { type: "object" } }] }),
        )
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: options.stateless ? undefined : () => crypto.randomUUID(),
          enableJsonResponse: true,
        })
        await protocol.connect(transport)
        return { protocol, transport }
      }
      const { protocol, transport } = await session()
      const requests: string[] = []
      const http = Bun.serve({
        port: 0,
        async fetch(request) {
          requests.push(`${request.method} ${new URL(request.url).pathname}`)
          if (!options.stateless) return transport.handleRequest(request)
          if (request.method === "GET") return new Response(null, { status: 405 })
          return (await session()).transport.handleRequest(request)
        },
      })
      return {
        requests,
        url: new URL("/mcp/dynamic", http.url).toString(),
        origin: new URL(http.url).origin,
        close: async () => {
          await protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

function withPolicy(origin: string) {
  const policy = JSON.stringify({ remote: [{ origin, path: "^/mcp/(dynamic|c/[A-Za-z0-9_-]+)$" }] })
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[McpAllow.ENV]
      process.env[McpAllow.ENV] = policy
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[McpAllow.ENV]
        else process.env[McpAllow.ENV] = previous
      }),
  )
}

it.instance("a refused remote entry never opens a connection", () =>
  Effect.gen(function* () {
    const server = yield* recordingServer()
    yield* withPolicy("https://identity.alterspective.com.au")
    const mcp = yield* MCP.Service

    const result = yield* mcp.add("ks-refused", { type: "remote", url: server.url })

    expect((result.status as Record<string, MCP.Status>)["ks-refused"]).toEqual({
      status: "failed",
      error: `blocked by OPENCODE_MCP_ALLOW: ${server.origin}/mcp/dynamic is not an allowed MCP URL`,
    })
    yield* mcp.connect("ks-refused")
    expect(Object.keys(yield* mcp.tools())).toEqual([])
    expect(server.requests).toEqual([])
  }),
)

it.instance("a refused local entry never spawns its process", () =>
  Effect.gen(function* () {
    yield* withPolicy("https://identity.alterspective.com.au")
    const test = yield* TestInstance
    const marker = path.join(test.directory, "spawned.txt")
    const mcp = yield* MCP.Service

    const result = yield* mcp.add("ks-local", {
      type: "local",
      command: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
    })

    expect((result.status as Record<string, MCP.Status>)["ks-local"]).toEqual({
      status: "failed",
      error: 'blocked by OPENCODE_MCP_ALLOW: "ks-local" is not a remote MCP server',
    })
    yield* Effect.sleep("300 millis")
    expect(fs.existsSync(marker)).toBe(false)
  }),
)

it.instance("an allowed remote entry still connects", () =>
  Effect.gen(function* () {
    const server = yield* recordingServer()
    yield* withPolicy(server.origin)
    const mcp = yield* MCP.Service

    const result = yield* mcp.add("ks-allowed", { type: "remote", url: server.url })

    expect((result.status as Record<string, MCP.Status>)["ks-allowed"]).toEqual({ status: "connected" })
    expect(Object.keys(yield* mcp.tools())).toEqual(["ks-allowed_probe"])
    expect(server.requests.length).toBeGreaterThan(0)
  }),
)

it.instance("startAuth refuses a blocked entry before any request", () =>
  Effect.gen(function* () {
    const server = yield* recordingServer()
    yield* withPolicy("https://identity.alterspective.com.au")
    const mcp = yield* MCP.Service
    yield* mcp.add("ks-auth", { type: "remote", url: server.url })

    const exit = yield* mcp.startAuth("ks-auth").pipe(Effect.exit)

    expect(exit._tag).toBe("Failure")
    expect(String(exit)).toContain("blocked by OPENCODE_MCP_ALLOW")
    expect(server.requests).toEqual([])
  }),
)

// startAuth's transport sends through the single-flight fetch too, so a sign-in that overlaps a
// refresh elsewhere in the process cannot present the same refresh token twice (review R3-04).
it.instance("startAuth sends through the single-flight refresh fetch", () =>
  Effect.gen(function* () {
    const server = yield* recordingServer({ stateless: true })
    yield* withPolicy(server.origin)
    yield* Effect.addFinalizer(() => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore))
    const spy = yield* Effect.acquireRelease(
      Effect.sync(() => spyOn(OAuthProvider, "refreshSingleFlightFetch")),
      (s) => Effect.sync(() => s.mockRestore()),
    )
    const mcp = yield* MCP.Service
    yield* mcp.add("ks-signin", { type: "remote", url: server.url })
    // The spy sees the connect transports, which already use it: the probe itself works.
    expect(spy).toHaveBeenCalled()
    spy.mockClear()

    yield* mcp.startAuth("ks-signin")

    expect(spy).toHaveBeenCalled()
    expect(server.requests.length).toBeGreaterThan(0)
  }),
)

// #67 step 2: the delegate box configures Keystone entries as {type:"remote", url, oauth:false};
// the Authorization header is added outside the box. These tests prove that such an entry
// builds no OAuth provider, never discovers OAuth metadata, and never starts an in-box sign-in.

// Server that answers every request with a 401 advertising OAuth metadata on its own origin,
// so any OAuth discovery the client attempted would land here and be recorded.
function unauthorizedServer() {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const requests: string[] = []
      const http = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          requests.push(`${request.method} ${url.pathname}`)
          return new Response("unauthorized", {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp/dynamic"`,
            },
          })
        },
      })
      return {
        requests,
        url: new URL("/mcp/dynamic", http.url).toString(),
        origin: new URL(http.url).origin,
        close: () => http.stop(true),
      }
    }),
    (server) => Effect.sync(server.close),
  )
}

// Spies pass through to the real implementation; they only record calls.
function spyOAuth() {
  return Effect.acquireRelease(
    Effect.sync(() => ({
      tokens: spyOn(OAuthProvider.McpOAuthProvider.prototype, "tokens"),
      fetch: spyOn(globalThis, "fetch"),
    })),
    (spies) =>
      Effect.sync(() => {
        spies.tokens.mockRestore()
        spies.fetch.mockRestore()
      }),
  )
}

const fetchedPaths = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)).pathname)

const wellKnown = (paths: string[]) => paths.filter((p) => p.startsWith("/.well-known/"))

it.instance("oauth:false connects an allowed entry without an OAuth provider", () =>
  Effect.gen(function* () {
    const server = yield* recordingServer()
    yield* withPolicy(server.origin)
    const spies = yield* spyOAuth()
    const mcp = yield* MCP.Service

    const result = yield* mcp.add("ks-nooauth", { type: "remote", url: server.url, oauth: false })

    expect((result.status as Record<string, MCP.Status>)["ks-nooauth"]).toEqual({ status: "connected" })
    expect(Object.keys(yield* mcp.tools())).toEqual(["ks-nooauth_probe"])
    // No McpOAuthProvider was handed to the transports: they call tokens() on every request when one exists.
    expect(spies.tokens).not.toHaveBeenCalled()
    expect(wellKnown(server.requests)).toEqual([])
    expect(wellKnown(fetchedPaths(spies.fetch))).toEqual([])
    expect(yield* mcp.supportsOAuth("ks-nooauth")).toBe(false)
  }),
)

it.instance("control: an allowed entry without oauth:false does use an OAuth provider", () =>
  Effect.gen(function* () {
    const server = yield* recordingServer()
    yield* withPolicy(server.origin)
    const spies = yield* spyOAuth()
    const mcp = yield* MCP.Service

    yield* mcp.add("ks-withoauth", { type: "remote", url: server.url })

    expect(spies.tokens).toHaveBeenCalled()
  }),
)

it.instance("oauth:false marks a 401 as failed and never discovers OAuth metadata", () =>
  Effect.gen(function* () {
    const server = yield* unauthorizedServer()
    yield* withPolicy(server.origin)
    const spies = yield* spyOAuth()
    const mcp = yield* MCP.Service

    const result = yield* mcp.add("ks-401", { type: "remote", url: server.url, oauth: false })

    const status = (result.status as Record<string, MCP.Status>)["ks-401"]
    expect(status.status).toBe("failed")
    // The 401 itself failed it, not a timeout or a refused connection.
    expect(status.status === "failed" ? status.error : "").toMatch(/401|unauthori[sz]ed/i)
    expect((yield* mcp.status())["ks-401"].status).toBe("failed")
    expect(server.requests.length).toBeGreaterThan(0)
    expect(wellKnown(server.requests)).toEqual([])
    expect(wellKnown(fetchedPaths(spies.fetch))).toEqual([])
    expect(spies.tokens).not.toHaveBeenCalled()
  }),
)

it.instance("control: without oauth:false the same 401 starts OAuth discovery", () =>
  Effect.gen(function* () {
    const server = yield* unauthorizedServer()
    yield* withPolicy(server.origin)
    yield* spyOAuth()
    const mcp = yield* MCP.Service

    const result = yield* mcp.add("ks-401-oauth", { type: "remote", url: server.url })

    expect((result.status as Record<string, MCP.Status>)["ks-401-oauth"]).toEqual({ status: "needs_auth" })
    expect(server.requests).toContain("GET /.well-known/oauth-protected-resource/mcp/dynamic")
  }),
)

it.instance("startAuth refuses an oauth:false entry before any request", () =>
  Effect.gen(function* () {
    const server = yield* unauthorizedServer()
    yield* withPolicy(server.origin)
    const spies = yield* spyOAuth()
    const mcp = yield* MCP.Service
    yield* mcp.add("ks-nosignin", { type: "remote", url: server.url, oauth: false })
    server.requests.length = 0
    spies.fetch.mockClear()

    const exit = yield* mcp.startAuth("ks-nosignin").pipe(Effect.exit)

    expect(exit._tag).toBe("Failure")
    expect(String(exit)).toContain("has OAuth explicitly disabled")
    expect(String(exit)).not.toContain("blocked by OPENCODE_MCP_ALLOW")
    expect(server.requests).toEqual([])
    expect(spies.fetch).not.toHaveBeenCalled()
    expect(spies.tokens).not.toHaveBeenCalled()
  }),
)
