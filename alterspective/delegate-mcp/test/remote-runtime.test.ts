import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createRuntime } from "../src/runtime.ts"
import { createServer } from "../src/server.ts"
import { defaultConfig } from "../src/shared/config.ts"
import type { RemoteReadiness } from "../src/tools/context.ts"

const SENTINEL = "PRIVATE_RESPONSE_SENTINEL_241"

async function fixture(options: { health?: unknown; rawHealth?: string; healthStatus?: number; authStatus?: number; token?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ocd-remote-241-"))
  const repo = path.join(root, "repo")
  const home = path.join(root, "home")
  mkdirSync(repo)
  const requests: string[] = []
  const logs: string[] = []
  const mutations = { workspace: 0, bind: 0, local: 0 }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const route = new URL(request.url).pathname
    requests.push(`${request.method} ${route}`)
    if (route === "/health") return options.rawHealth === undefined
      ? Response.json(options.health ?? { service: "svc-coding-agent", status: "healthy", private: SENTINEL }, { status: options.healthStatus ?? 200 })
      : new Response(options.rawHealth, { status: options.healthStatus ?? 200 })
    if (route === "/api/v1/repos") {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-token")
      return Response.json({ repos: [{ repo: SENTINEL, repoClass: "org", residency: "local-only" }], private: SENTINEL }, { status: options.authStatus ?? 200 })
    }
    return Response.json({ private: SENTINEL }, { status: 500 })
  } })
  const runtime = await createRuntime({
    config: { ...defaultConfig({}), home, roots: [repo], backend: "remote", remoteUrl: `http://127.0.0.1:${server.port}`, remoteToken: options.token === false ? undefined : "fixture-token" },
    env: { OPENCODE_DELEGATE_NAME: "remote-fixture" },
    version: { version: "test", package: "test", sha: "fixture", dirty: false, built: null },
    log: { log: (...args) => { logs.push(JSON.stringify(args)) } },
  })
  const open = runtime.ctx.workspaces.open
  runtime.ctx.workspaces.open = async (...args) => { mutations.workspace++; return open(...args) }
  const bind = runtime.ctx.workspaces.bindSession
  runtime.ctx.workspaces.bindSession = async (...args) => { mutations.bind++; return bind(...args) }
  const forbidden = async (): Promise<never> => { mutations.local++; throw new Error("Local check must not run") }
  runtime.ctx.synapse.status = forbidden
  runtime.ctx.guard.checkRuntime = forbidden
  runtime.ctx.hostExec = forbidden
  const bridge = createServer(runtime.ctx)
  const client = new Client({ name: "remote-fixture", version: "test" })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await bridge.server.connect(st)
  await client.connect(ct)
  return { runtime, client, requests, repo, stopHTTP: () => server.stop(true),
    async close() { await client.close(); await bridge.close(); await runtime.shutdown("fixture complete"); server.stop(true) },
    assertUntouched() {
      expect(mutations).toEqual({ workspace: 0, bind: 0, local: 0 })
      expect(existsSync(path.join(home, "workspaces"))).toBe(false)
      expect(existsSync(home) ? readdirSync(home) : []).toEqual([])
      expect(requests.filter((request) => !request.startsWith("GET "))).toEqual([])
      expect(JSON.stringify(logs)).not.toContain(SENTINEL)
    },
  }
}

describe("remote containment through initialized MCP", () => {
  it("initializes without a held box, binding event, polling or local checks", async () => {
    const f = await fixture()
    try {
      expect((await f.client.listTools()).tools.length).toBeGreaterThan(0)
      // cli.ts uses these exact optional startup hooks after connecting the MCP server.
      expect(f.runtime.synapse).toBeUndefined()
      expect(f.runtime.keystone).toBeUndefined()
      const stopRefresh = f.runtime.synapse?.start() ?? (() => {})
      const stopKeystone = f.runtime.keystone?.start() ?? (() => {})
      stopKeystone()
      stopRefresh()
      expect(f.runtime.ctx.peekBox()).toBeUndefined()
      let bindings = 0
      f.runtime.ctx.onBox(() => { bindings++ })()
      expect(bindings).toBe(0)
      expect(await f.runtime.ctx.supervisorService.status()).toMatchObject({ state: "unavailable" })
      const ctx = f.runtime.ctx
      for (const invoke of [() => ctx.box(), () => ctx.restartBox(), () => ctx.boxExec(["ignored"]), () => ctx.supervisorService.ensure(), () => ctx.supervisorService.replace({ force: false }), () => ctx.supervisorService.login("ignored"), () => ctx.supervisorService.verifyLive()])
        await expect(invoke()).rejects.toMatchObject({ code: "policy_unverified" })
      expect(() => ctx.apiFor({ baseUrl: "http://127.0.0.1:1", password: "unused" })).toThrow("Remote execution is blocked")
      expect(f.requests).toEqual([])
      f.assertUntouched()
    } finally { await f.close() }
  }, 5000)

  it("refuses modern/legacy start, readonly/model options, saved-session send and every task engine before capture or POST", async () => {
    const f = await fixture()
    try {
      for (const name of ["oc_start_session", "code_start_session"])
        for (const extra of [{}, { profile: "readonly" }, { model: "synapse/auto" }, { keystone: [] }]) {
          const result = await f.client.callTool({ name, arguments: { directory: f.repo, allowShared: true, ...extra } })
          expect(result.isError).toBe(true)
          expect(result.structuredContent).toMatchObject({ code: "policy_unverified" })
        }
      for (const name of ["oc_send", "code_send"]) {
        const result = await f.client.callTool({ name, arguments: { sessionID: "ses_0123456789abcdef", message: "READ_ONLY_MARKER", syncRef: "probe" } })
        expect(result.isError).toBe(true)
        expect(result.structuredContent).toMatchObject({ code: "policy_unverified" })
      }
      for (const name of ["delegate_task", "code_delegate_task"])
        for (const engine of ["auto", "deepseek", "opencode"]) {
          const result = await f.client.callTool({ name, arguments: { directory: f.repo, prompt: "REAL_TASK_NOT_THE_TITLE", engine } })
          expect(result.isError).toBe(true)
          expect(result.structuredContent).toMatchObject({ code: "policy_unverified" })
        }
      expect(f.requests).toEqual([])
      f.assertUntouched()
    } finally { await f.close() }
  })

  it.each(["oc_doctor", "code_doctor"])("%s reports measured health/auth but never verified, even start:true", async (name) => {
    const f = await fixture()
    try {
      const result = await f.client.callTool({ name, arguments: { start: true } })
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({ backend: "remote", verified: false, guard: { ok: false, code: "policy_unverified" }, remote: { health: { outcome: "healthy", httpStatus: 200 }, authentication: { outcome: "authenticated", httpStatus: 200 } } })
      for (const field of ["box", "mcp", "live", "synapse", "keystone", "keystoneAuth", "egress", "leases"]) expect(result.structuredContent).not.toHaveProperty(field)
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      expect(f.requests.sort()).toEqual(["GET /api/v1/repos", "GET /health"])
      f.assertUntouched()
    } finally { await f.close() }
  })

  it.each([401, 403])("keeps public health separate from protected HTTP %i", async (authStatus) => {
    const f = await fixture({ authStatus })
    try {
      const result = await f.client.callTool({ name: "code_doctor", arguments: {} })
      expect(result.structuredContent).toMatchObject({ verified: false, remote: { health: { outcome: "healthy" }, authentication: { outcome: "needs_auth", httpStatus: authStatus } } })
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      f.assertUntouched()
    } finally { await f.close() }
  })

  it("does not request a protected catalog or mint a grant without a configured token", async () => {
    const f = await fixture({ token: false })
    try {
      const result = await f.client.callTool({ name: "code_doctor", arguments: {} })
      expect(result.structuredContent).toMatchObject({ verified: false, remote: { health: { outcome: "healthy" }, authentication: { outcome: "needs_auth" } } })
      const remote = (result.structuredContent as { remote: RemoteReadiness }).remote
      expect(remote.authentication.httpStatus).toBeUndefined()
      expect(remote.authentication.shapeValid).toBeUndefined()
      expect(f.requests).toEqual(["GET /health"])
      f.assertUntouched()
    } finally { await f.close() }
  })

  it.each(["degraded", "unhealthy", "future-status"])("keeps %s health separate from verification", async (status) => {
    const f = await fixture({ health: { service: "svc-coding-agent", status, private: SENTINEL } })
    try {
      const result = await f.client.callTool({ name: "code_doctor", arguments: {} })
      expect(result.structuredContent).toMatchObject({ verified: false, remote: { health: { outcome: status === "future-status" ? "unknown" : status } } })
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      f.assertUntouched()
    } finally { await f.close() }
  })

  it.each([
    [{ rawHealth: SENTINEL }, "invalid_json"],
    [{ healthStatus: 503 }, "http_error"],
  ] as const)("redacts malformed/error replies in actual doctor output and logs %j", async (options, outcome) => {
    const f = await fixture(options)
    try {
      const result = await f.client.callTool({ name: "code_doctor", arguments: {} })
      expect(result.structuredContent).toMatchObject({ verified: false, remote: { health: { outcome }, authentication: { outcome: "authenticated" } } })
      expect(JSON.stringify(result)).not.toContain(SENTINEL)
      f.assertUntouched()
    } finally { await f.close() }
  })

  it("reports failed HTTP transport without fabricating remote readiness", async () => {
    const f = await fixture()
    try {
      f.stopHTTP()
      const result = await f.client.callTool({ name: "code_doctor", arguments: {} })
      expect(result.structuredContent).toMatchObject({ verified: false, remote: { health: { outcome: "unreachable" }, authentication: { outcome: "unreachable" } } })
      f.assertUntouched()
    } finally { await f.close() }
  })
})
