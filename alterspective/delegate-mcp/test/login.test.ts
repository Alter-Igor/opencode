import { afterEach, describe, expect, test } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { CALLBACK_PATH, login } from "../src/supervisor/login.ts"
import type { OpencodeApi } from "../src/shared/opencode-api.ts"
import { DelegateError } from "../src/shared/errors.ts"
import { defaultConfig } from "../src/shared/config.ts"

const AUTH_ORIGIN = "https://identity.example.test"

type Recorded = { method: string; path: string; directory?: string; body?: unknown }
type Page = { status: number; text: string }

type FakeOptions = {
  authUrl?: string
  state?: string
  finalStatus?: string
  callbackStatus?: number
  /** The relay call to the box throws (box unreachable or timed out). */
  callbackThrows?: boolean
  /** Awaited before answering the final GET /mcp, so a test can act while the listener is still open. */
  beforeStatus?: () => Promise<void>
}

function fakeApi(opts: FakeOptions = {}) {
  const calls: Recorded[] = []
  const api: OpencodeApi = {
    async call<T>(input: { method?: string; path: string; directory?: string; body?: unknown }) {
      calls.push({ method: input.method ?? "GET", path: input.path, directory: input.directory, body: input.body })
      if (input.path.endsWith("/auth")) {
        const data = { authorizationUrl: opts.authUrl ?? `${AUTH_ORIGIN}/api/oauth/authorize?state=s1`, oauthState: opts.state ?? "s1" }
        return { status: 200, data: data as T }
      }
      if (input.path.endsWith("/auth/callback")) {
        if (opts.callbackThrows) throw new DelegateError("server_down", "The delegate server did not answer in time.", "Run oc_doctor.", "timeout")
        return { status: opts.callbackStatus ?? 200, data: { status: "connected" } as T }
      }
      await opts.beforeStatus?.()
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

const hit = (port: number, query: string): Promise<Page> =>
  fetch(`http://127.0.0.1:${port}${CALLBACK_PATH}?${query}`).then(async (r) => ({ status: r.status, text: await r.text() }))
/** Like `hit`, but a refused connection is status 0 (the listener is closed). */
const tryHit = (port: number, query: string): Promise<Page> => hit(port, query).catch(() => ({ status: 0, text: "refused" }))

const blockers: http.Server[] = []
afterEach(async () => {
  for (const server of blockers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Proves login closed its listener: the port can be bound again. */
async function portIsFree(port: number): Promise<void> {
  const again = http.createServer()
  blockers.push(again)
  await new Promise<void>((resolve, reject) => {
    again.once("error", reject)
    again.listen(port, "127.0.0.1", () => resolve())
  })
}

describe("login relay", () => {
  test("refuses a wrong state, relays the code exactly once, reports connected, then closes", async () => {
    const port = await freePort()
    const seen: Page[] = []
    // The 4th hit lands while login still waits on the final status, so the listener is open and
    // must answer 409 (deterministic, not "409 or closed").
    const { api, calls } = fakeApi({ beforeStatus: async () => void seen.push(await tryHit(port, "code=again&state=s1")) })
    const opener = async () => {
      seen.push(await hit(port, "code=bad&state=wrong"))
      seen.push(await hit(port, "state=s1"))
      seen.push(await hit(port, "code=abc&state=s1"))
    }
    let browser: Promise<void> | undefined
    const result = await login(api, "ks-delegate", { port, authOrigin: AUTH_ORIGIN, opener: () => void (browser = opener()) })
    await browser
    expect(result).toBe("connected")
    expect(seen.map((s) => s.status)).toEqual([400, 400, 200, 409])
    // After login returns the listener is gone: the connection is refused.
    expect((await tryHit(port, "code=late&state=s1")).status).toBe(0)
    const relays = calls.filter((c) => c.path === "/mcp/ks-delegate/auth/callback")
    expect(relays).toHaveLength(1)
    expect(relays[0]?.body).toEqual({ code: "abc" })
    expect(calls.every((c) => c.directory === "/sessions")).toBe(true)
  })

  test("a denied sign-in (error=...) relays nothing, tells the browser, and is failed", async () => {
    const port = await freePort()
    const { api, calls } = fakeApi()
    let page: Promise<Page> | undefined
    const result = await login(api, "ks-delegate", { port, authOrigin: AUTH_ORIGIN, opener: () => void (page = hit(port, "error=access_denied&state=s1")) })
    expect(result).toBe("failed")
    const shown = await page!
    expect(shown.status).toBe(400)
    expect(shown.text).toContain("Sign-in was not completed")
    expect(calls.some((c) => c.path.endsWith("/auth/callback"))).toBe(false)
    await portIsFree(port)
  })

  test("a relay that throws shows 502, rethrows the box error, and frees the port", async () => {
    const port = await freePort()
    const { api } = fakeApi({ callbackThrows: true })
    let page: Promise<Page> | undefined
    const error = await login(api, "ks-delegate", { port, authOrigin: AUTH_ORIGIN, opener: () => void (page = hit(port, "code=abc&state=s1")) }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DelegateError)
    expect((error as DelegateError).code).toBe("server_down")
    expect((await page!).status).toBe(502)
    await portIsFree(port)
  })

  test("a non-2xx callback from the box shows the refusal and reports the real entry status", async () => {
    const port = await freePort()
    const { api, calls } = fakeApi({ callbackStatus: 500, finalStatus: "needs_auth" })
    const lines: string[] = []
    const logger = { log: (level: string, _component: string, msg: string, fields?: object) => void lines.push(JSON.stringify({ level, msg, fields })) }
    let page: Promise<Page> | undefined
    const result = await login(api, "ks-delegate", { port, authOrigin: AUTH_ORIGIN, logger, opener: () => void (page = hit(port, "code=abc&state=s1")) })
    expect(result).toBe("failed")
    const shown = await page!
    expect(shown.status).toBe(502)
    expect(shown.text).toContain("HTTP 500")
    expect(calls.filter((c) => c.path.endsWith("/auth/callback"))).toHaveLength(1)
    expect(lines.some((l) => l.includes('"level":"warn"') && l.includes('"status":500'))).toBe(true)
    await portIsFree(port)
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
    await portIsFree(port)
  })

  test("refuses to open a non-Keystone authorization URL, and frees the port", async () => {
    const port = await freePort()
    const { api } = fakeApi({ authUrl: "https://evil.example.test/authorize?state=s1" })
    let opened = false
    const error = await login(api, "ks-delegate", { port, authOrigin: AUTH_ORIGIN, opener: () => (opened = true) }).catch((e: unknown) => e)
    expect((error as DelegateError).code).toBe("policy_violation")
    expect(opened).toBe(false)
    await portIsFree(port)
  })

  test("the default auth origin is config.keystoneOrigin", async () => {
    const port = await freePort()
    // With no authOrigin option, a URL on the test origin is refused...
    const { api } = fakeApi()
    const error = await login(api, "ks-delegate", { port, opener: () => {} }).catch((e: unknown) => e)
    expect((error as DelegateError).code).toBe("policy_violation")
    // ...and one on config.keystoneOrigin is opened.
    const ok = fakeApi({ authUrl: `${defaultConfig({}).keystoneOrigin}/api/oauth/authorize?state=s1` })
    const result = await login(ok.api, "ks-delegate", { port, opener: () => void hit(port, "code=abc&state=s1") })
    expect(result).toBe("connected")
  })

  test("entry names follow the guard's KS_NAME rule", async () => {
    const { api, calls } = fakeApi()
    for (const name of ["evil-rag", "ks-", "ks-Delegate", "ks-a_b", "ks-a/b", `ks-${"a".repeat(80)}`]) {
      const error = await login(api, name, { opener: () => {} }).catch((e: unknown) => e)
      expect({ name, code: (error as DelegateError).code }).toEqual({ name, code: "invalid_input" })
    }
    expect(calls).toHaveLength(0)
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
