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

/** An RFC 7636 example S256 challenge. */
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

type UrlParts = { origin?: string; path?: string; set?: Record<string, string>; drop?: string; extra?: string }

/**
 * A well-formed Keystone authorization request for ks-rag-global back to the listener on `port`,
 * with optional damage. `resource` is the entry's own connection, as the MCP SDK sends it (R4-01).
 */
function authUrl(port: number, o: UrlParts = {}): string {
  const resource = `${AUTH_ORIGIN}/mcp/c/rag-global`
  const q = new URLSearchParams({ response_type: "code", client_id: "c1", code_challenge: CHALLENGE, code_challenge_method: "S256", redirect_uri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, state: "s1", resource, ...o.set })
  if (o.drop) q.delete(o.drop)
  return `${o.origin ?? AUTH_ORIGIN}${o.path ?? "/api/oauth/authorize"}?${q}${o.extra ?? ""}`
}

type FakeOptions = {
  /** The listener port the default authorization URL redirects to. */
  port?: number
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
        const data = { authorizationUrl: opts.authUrl ?? authUrl(opts.port ?? 0), oauthState: opts.state ?? "s1" }
        return { status: 200, data: data as T }
      }
      if (input.path.endsWith("/auth/callback")) {
        if (opts.callbackThrows) throw new DelegateError("server_down", "The delegate server did not answer in time.", "Run oc_doctor.", "timeout")
        return { status: opts.callbackStatus ?? 200, data: { status: "connected" } as T }
      }
      await opts.beforeStatus?.()
      return { status: 200, data: { "ks-rag-global": { status: opts.finalStatus ?? "connected" } } as T }
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
    const { api, calls } = fakeApi({ port, beforeStatus: async () => void seen.push(await tryHit(port, "code=again&state=s1")) })
    const opener = async () => {
      seen.push(await hit(port, "code=bad&state=wrong"))
      seen.push(await hit(port, "state=s1"))
      seen.push(await hit(port, "code=abc&state=s1"))
    }
    let browser: Promise<void> | undefined
    const result = await login(api, "ks-rag-global", { port, authOrigin: AUTH_ORIGIN, opener: () => void (browser = opener()) })
    await browser
    expect(result).toBe("connected")
    expect(seen.map((s) => s.status)).toEqual([400, 400, 200, 409])
    // After login returns the listener is gone: the connection is refused.
    expect((await tryHit(port, "code=late&state=s1")).status).toBe(0)
    const relays = calls.filter((c) => c.path === "/mcp/ks-rag-global/auth/callback")
    expect(relays).toHaveLength(1)
    expect(relays[0]?.body).toEqual({ code: "abc" })
    expect(calls.every((c) => c.directory === "/sessions")).toBe(true)
  })

  test("a denied sign-in (error=...) relays nothing, tells the browser, and is failed", async () => {
    const port = await freePort()
    const { api, calls } = fakeApi({ port })
    let page: Promise<Page> | undefined
    const result = await login(api, "ks-rag-global", { port, authOrigin: AUTH_ORIGIN, opener: () => void (page = hit(port, "error=access_denied&state=s1")) })
    expect(result).toBe("failed")
    const shown = await page!
    expect(shown.status).toBe(400)
    expect(shown.text).toContain("Sign-in was not completed")
    expect(calls.some((c) => c.path.endsWith("/auth/callback"))).toBe(false)
    await portIsFree(port)
  })

  test("a relay that throws shows 502, rethrows the box error, and frees the port", async () => {
    const port = await freePort()
    const { api } = fakeApi({ port, callbackThrows: true })
    let page: Promise<Page> | undefined
    const error = await login(api, "ks-rag-global", { port, authOrigin: AUTH_ORIGIN, opener: () => void (page = hit(port, "code=abc&state=s1")) }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DelegateError)
    expect((error as DelegateError).code).toBe("server_down")
    expect((await page!).status).toBe(502)
    await portIsFree(port)
  })

  test("a non-2xx callback from the box shows the refusal and reports the real entry status", async () => {
    const port = await freePort()
    const { api, calls } = fakeApi({ port, callbackStatus: 500, finalStatus: "needs_auth" })
    const lines: string[] = []
    const logger = { log: (level: string, _component: string, msg: string, fields?: object) => void lines.push(JSON.stringify({ level, msg, fields })) }
    let page: Promise<Page> | undefined
    const result = await login(api, "ks-rag-global", { port, authOrigin: AUTH_ORIGIN, logger, opener: () => void (page = hit(port, "code=abc&state=s1")) })
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
    const { api } = fakeApi({ port, finalStatus: "needs_auth" })
    const result = await login(api, "ks-rag-global", { port, authOrigin: AUTH_ORIGIN, opener: () => void hit(port, "code=abc&state=s1") })
    expect(result).toBe("failed")
  })

  test("a busy port gives port_busy and never starts the flow", async () => {
    const port = await freePort()
    const blocker = http.createServer()
    blockers.push(blocker)
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", () => resolve()))
    const { api, calls } = fakeApi({ port })
    const error = await login(api, "ks-rag-global", { port, authOrigin: AUTH_ORIGIN, opener: () => {} }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DelegateError)
    expect((error as DelegateError).code).toBe("port_busy")
    expect(calls).toHaveLength(0)
  })

  test("times out as failed, relays nothing, and frees the port", async () => {
    const port = await freePort()
    const { api, calls } = fakeApi({ port })
    const result = await login(api, "ks-rag-global", { port, authOrigin: AUTH_ORIGIN, timeoutMs: 150, opener: () => {} })
    expect(result).toBe("failed")
    expect(calls.some((c) => c.path.endsWith("/auth/callback"))).toBe(false)
    await portIsFree(port)
  })

  test("refuses to open a non-Keystone authorization URL, and frees the port", async () => {
    const port = await freePort()
    const { api } = fakeApi({ port, authUrl: authUrl(port, { origin: "https://evil.example.test" }) })
    let opened = false
    const error = await login(api, "ks-rag-global", { port, authOrigin: AUTH_ORIGIN, opener: () => (opened = true) }).catch((e: unknown) => e)
    expect((error as DelegateError).code).toBe("policy_violation")
    expect(opened).toBe(false)
    await portIsFree(port)
  })

  test("R3-06: only an S256 PKCE code request to the authorize endpoint, back to this listener, is opened", async () => {
    const port = await freePort()
    const bad: Record<string, string> = {
      "another Keystone page": authUrl(port, { path: "/settings/security" }),
      "a lookalike path": authUrl(port, { path: "/api/oauth/authorize/../consent" }),
      "an implicit grant": authUrl(port, { set: { response_type: "token" } }),
      "no response_type": authUrl(port, { drop: "response_type" }),
      "no code_challenge": authUrl(port, { drop: "code_challenge" }),
      "an empty code_challenge": authUrl(port, { set: { code_challenge: "" } }),
      "a plain challenge": authUrl(port, { set: { code_challenge_method: "plain" } }),
      "no challenge method": authUrl(port, { drop: "code_challenge_method" }),
      "no redirect_uri": authUrl(port, { drop: "redirect_uri" }),
      "a redirect to another port": authUrl(port, { set: { redirect_uri: `http://127.0.0.1:${port + 1}${CALLBACK_PATH}` } }),
      "a redirect to another host": authUrl(port, { set: { redirect_uri: `https://evil.example.test${CALLBACK_PATH}` } }),
      "a redirect to localhost": authUrl(port, { set: { redirect_uri: `http://localhost:${port}${CALLBACK_PATH}` } }),
      "a second redirect_uri": authUrl(port, { extra: `&redirect_uri=${encodeURIComponent("https://evil.example.test/cb")}` }),
      "user info in the URL": authUrl(port).replace("https://", "https://owner@"),
      // R4-01: the owner's consent is only for this entry's own connection.
      "no resource": authUrl(port, { drop: "resource" }),
      "the dynamic relay as resource": authUrl(port, { set: { resource: `${AUTH_ORIGIN}/mcp/dynamic` } }),
      "the admin MCP as resource": authUrl(port, { set: { resource: `${AUTH_ORIGIN}/api/mcp` } }),
      "another connection as resource": authUrl(port, { set: { resource: `${AUTH_ORIGIN}/mcp/c/github` } }),
      "a resource on another origin": authUrl(port, { set: { resource: "https://evil.example.test/mcp/c/rag-global" } }),
      "a resource with a trailing slash": authUrl(port, { set: { resource: `${AUTH_ORIGIN}/mcp/c/rag-global/` } }),
      "a second resource": authUrl(port, { extra: `&resource=${encodeURIComponent(`${AUTH_ORIGIN}/mcp/dynamic`)}` }),
    }
    for (const [why, url] of Object.entries(bad)) {
      let opened = false
      const error = await login(fakeApi({ authUrl: url }).api, "ks-rag-global", { port, authOrigin: AUTH_ORIGIN, opener: () => (opened = true) }).catch((e: unknown) => e)
      expect({ why, code: (error as DelegateError).code, opened }).toEqual({ why, code: "policy_violation", opened: false })
    }
    await portIsFree(port)
  })

  test("R3-06: the well-formed request is opened as given", async () => {
    const port = await freePort()
    const urls: string[] = []
    const result = await login(fakeApi({ port }).api, "ks-rag-global", { port, authOrigin: AUTH_ORIGIN, opener: (url) => void (urls.push(url), hit(port, "code=abc&state=s1")) })
    expect(result).toBe("connected")
    expect(urls).toEqual([authUrl(port)])
  })

  test("R4-03: the URL that was checked is the one opened, not the box's raw text", async () => {
    const port = await freePort()
    // The WHATWG parser drops leading C0/space and inner tab/CR/LF, and reads `\` as `/` in an
    // https URL; a browser or rundll32 given the raw text may read it differently.
    const good = authUrl(port)
    const raws = [
      ` \u0001${good}`,
      good.replace("/api/oauth/authorize", "\\api\\oauth\\authorize"),
      good.replace("/api/oauth/authorize", "/api/oauth/auth\torize").replace("identity.", "iden\ntity."),
    ]
    for (const raw of raws) {
      expect(raw).not.toBe(good)
      const urls: string[] = []
      const result = await login(fakeApi({ authUrl: raw }).api, "ks-rag-global", { port, authOrigin: AUTH_ORIGIN, opener: (url) => void (urls.push(url), hit(port, "code=abc&state=s1")) })
      expect({ raw, result, urls }).toEqual({ raw, result: "connected", urls: [good] })
      expect(new URL(urls[0]!).href).toBe(urls[0]!)
    }
  })

  test("the auth origin is the one from the config passed in, not the default config (A-20)", async () => {
    const port = await freePort()
    const custom = { ...defaultConfig({}), keystoneOrigin: AUTH_ORIGIN }
    // A URL on the default Keystone origin is refused when the bridge runs with another config...
    const onDefault = fakeApi({ port, authUrl: authUrl(port, { origin: defaultConfig({}).keystoneOrigin }) })
    const error = await login(onDefault.api, "ks-rag-global", { port, authOrigin: custom.keystoneOrigin, opener: () => {} }).catch((e: unknown) => e)
    expect((error as DelegateError).code).toBe("policy_violation")
    // ...and one on that config's origin is opened.
    const onCustom = fakeApi({ port })
    const result = await login(onCustom.api, "ks-rag-global", { port, authOrigin: custom.keystoneOrigin, opener: () => void hit(port, "code=abc&state=s1") })
    expect(result).toBe("connected")
  })

  test("every call and error is logged with one correlation id (A-17)", async () => {
    const port = await freePort()
    const lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = []
    const logger = { log: (level: string, _c: string, msg: string, fields: Record<string, unknown> = {}) => void lines.push({ level, msg, fields }) }
    const { api } = fakeApi({ port })
    await login(api, "ks-rag-global", { port, authOrigin: AUTH_ORIGIN, logger, correlationId: "cid-1", opener: () => void hit(port, "code=abc&state=s1") })
    expect(lines.map((l) => l.msg)).toContain("login called")
    expect(lines.find((l) => l.msg === "login done")?.fields).toMatchObject({ result: "connected", entry: "ks-rag-global" })
    expect(lines.every((l) => l.fields.correlationId === "cid-1")).toBe(true)
    lines.length = 0
    await login(api, "evil", { authOrigin: AUTH_ORIGIN, logger }).catch(() => undefined)
    const failed = lines.find((l) => l.msg === "login failed")!
    expect(failed.level).toBe("error")
    expect(failed.fields.code).toBe("invalid_input")
    expect(typeof failed.fields.correlationId).toBe("string")
    expect(new Set(lines.map((l) => l.fields.correlationId)).size).toBe(1)
  })

  test("a throwing logger never breaks the sign-in (A-11)", async () => {
    const port = await freePort()
    const logger = { log: () => { throw new Error("log sink down") } }
    const result = await login(fakeApi({ port }).api, "ks-rag-global", { port, authOrigin: AUTH_ORIGIN, logger, opener: () => void hit(port, "code=abc&state=s1") })
    expect(result).toBe("connected")
  })

  test("entry names follow the guard's KS_NAME rule", async () => {
    const { api, calls } = fakeApi()
    for (const name of ["evil-rag", "ks-", "ks-Delegate", "ks-a_b", "ks-a/b", `ks-${"a".repeat(80)}`]) {
      const error = await login(api, name, { authOrigin: AUTH_ORIGIN, opener: () => {} }).catch((e: unknown) => e)
      expect({ name, code: (error as DelegateError).code }).toEqual({ name, code: "invalid_input" })
    }
    expect(calls).toHaveLength(0)
  })

  test("never logs the code or the URL query", async () => {
    const port = await freePort()
    const { api } = fakeApi({ port, authUrl: authUrl(port, { extra: "&secretq=Q123" }) })
    const lines: string[] = []
    const logger = { log: (level: string, component: string, msg: string, fields?: object) => void lines.push(JSON.stringify({ level, component, msg, fields })) }
    await login(api, "ks-rag-global", { port, authOrigin: AUTH_ORIGIN, logger, opener: () => void hit(port, "code=CODE987&state=bad").then(() => hit(port, "code=CODE987&state=s1")) })
    const all = lines.join("\n")
    expect(lines.length).toBeGreaterThan(0)
    expect(all).not.toContain("CODE987")
    expect(all).not.toContain("Q123")
  })
})
