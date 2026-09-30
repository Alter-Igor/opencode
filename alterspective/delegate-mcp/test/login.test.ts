import { afterEach, describe, expect, test } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { CALLBACK_PATH, login } from "../src/supervisor/login.ts"
import type { OpencodeApi } from "../src/shared/opencode-api.ts"
import { DelegateError } from "../src/shared/errors.ts"

const AUTH_ORIGIN = "https://identity.example.test"

type Recorded = { method: string; path: string; directory?: string; body?: unknown }

function fakeApi(opts: { authUrl?: string; state?: string; finalStatus?: string; callbackStatus?: number } = {}) {
  const calls: Recorded[] = []
  const api: OpencodeApi = {
    async call<T>(input: { method?: string; path: string; directory?: string; body?: unknown }) {
      calls.push({ method: input.method ?? "GET", path: input.path, directory: input.directory, body: input.body })
      if (input.path.endsWith("/auth")) {
        const data = { authorizationUrl: opts.authUrl ?? `${AUTH_ORIGIN}/api/oauth/authorize?state=s1`, oauthState: opts.state ?? "s1" }
        return { status: 200, data: data as T }
      }
      if (input.path.endsWith("/auth/callback")) return { status: opts.callbackStatus ?? 200, data: { status: "connected" } as T }
      return { status: 200, data: { "ks-delegate": { status: opts.finalStatus ?? "connected" } } as T }
    },
  }
  return { api, calls }
}

async function freePort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const hit = (port: number, query: string) => fetch(`http://127.0.0.1:${port}${CALLBACK_PATH}?${query}`).then(async (r) => ({ status: r.status, text: await r.text() }))

const blockers: http.Server[] = []
afterEach(async () => {
  for (const server of blockers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe("login relay", () => {
  test("refuses a wrong state, relays the code exactly once, reports connected", async () => {
    const port = await freePort()
    const { api, calls } = fakeApi()
    const seen: Array<{ status: number; text: string }> = []
    const opener = async () => {
      seen.push(await hit(port, "code=bad&state=wrong"))
      seen.push(await hit(port, "state=s1"))
      seen.push(await hit(port, "code=abc&state=s1"))
      seen.push(await hit(port, "code=again&state=s1").catch(() => ({ status: 0, text: "closed" })))
    }
    let browser: Promise<void> | undefined
    const result = await login(api, "ks-delegate", { port, authOrigin: AUTH_ORIGIN, opener: () => void (browser = opener()) })
    await browser
    expect(result).toBe("connected")
    expect(seen[0]?.status).toBe(400)
    expect(seen[1]?.status).toBe(400)
    expect(seen[2]?.status).toBe(200)
    expect([0, 409]).toContain(seen[3]?.status ?? -1)
    const relays = calls.filter((c) => c.path === "/mcp/ks-delegate/auth/callback")
    expect(relays).toHaveLength(1)
    expect(relays[0]?.body).toEqual({ code: "abc" })
    expect(calls.every((c) => c.directory === "/sessions")).toBe(true)
  })

  test("returns failed when the box still reports the entry as not connected", async () => {
    const port = await freePort()
    const { api } = fakeApi({ finalStatus: "needs_auth" })
    const result = await login(api, "ks-delegate", { port, authOrigin: AUTH_ORIGIN, opener: () => void hit(port, "code=abc&state=s1") })
    expect(result).toBe("failed")
  })

  test("a busy port gives port_busy and never starts the flow", async () => {
    const port = await freePort()
    const blocker = http.createServer()
    blockers.push(blocker)
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", () => resolve()))
    const { api, calls } = fakeApi()
    const error = await login(api, "ks-delegate", { port, authOrigin: AUTH_ORIGIN, opener: () => {} }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DelegateError)
    expect((error as DelegateError).code).toBe("port_busy")
    expect(calls).toHaveLength(0)
  })

  test("times out as failed, relays nothing, and frees the port", async () => {
    const port = await freePort()
    const { api, calls } = fakeApi()
    const result = await login(api, "ks-delegate", { port, authOrigin: AUTH_ORIGIN, timeoutMs: 150, opener: () => {} })
    expect(result).toBe("failed")
    expect(calls.some((c) => c.path.endsWith("/auth/callback"))).toBe(false)
    const again = http.createServer()
    blockers.push(again)
    await new Promise<void>((resolve, reject) => {
      again.once("error", reject)
      again.listen(port, "127.0.0.1", () => resolve())
    })
  })

  test("refuses to open a non-Keystone authorization URL", async () => {
    const port = await freePort()
    const { api } = fakeApi({ authUrl: "https://evil.example.test/authorize?state=s1" })
    let opened = false
    const error = await login(api, "ks-delegate", { port, authOrigin: AUTH_ORIGIN, opener: () => (opened = true) }).catch((e: unknown) => e)
    expect((error as DelegateError).code).toBe("policy_violation")
    expect(opened).toBe(false)
  })

  test("rejects entry names that are not ks-*", async () => {
    const { api } = fakeApi()
    const error = await login(api, "evil-rag", { opener: () => {} }).catch((e: unknown) => e)
    expect((error as DelegateError).code).toBe("invalid_input")
  })

  test("never logs the code or the URL query", async () => {
    const port = await freePort()
    const { api } = fakeApi({ authUrl: `${AUTH_ORIGIN}/api/oauth/authorize?state=s1&secretq=Q123` })
    const lines: string[] = []
    const logger = { log: (level: string, component: string, msg: string, fields?: object) => void lines.push(JSON.stringify({ level, component, msg, fields })) }
    await login(api, "ks-delegate", { port, authOrigin: AUTH_ORIGIN, logger, opener: () => void hit(port, "code=CODE987&state=bad").then(() => hit(port, "code=CODE987&state=s1")) })
    const all = lines.join("\n")
    expect(lines.length).toBeGreaterThan(0)
    expect(all).not.toContain("CODE987")
    expect(all).not.toContain("Q123")
  })
})
