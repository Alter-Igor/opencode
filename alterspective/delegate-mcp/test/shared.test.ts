import { describe, expect, test } from "bun:test"
import { createLogger, redact } from "../src/shared/log.ts"
import { createApi, expectOk } from "../src/shared/opencode-api.ts"
import { DelegateError } from "../src/shared/errors.ts"
import { defaultConfig, mcpAllowPolicy } from "../src/shared/config.ts"

describe("log", () => {
  test("redacts secret-looking fields", () => {
    expect(redact({ password: "p", apiKey: "k", Authorization: "a", sessionID: "s" })).toEqual({
      password: "[redacted]",
      apiKey: "[redacted]",
      Authorization: "[redacted]",
      sessionID: "s",
    })
  })

  test("writes one JSON line with the required fields and never stdout", () => {
    const lines: string[] = []
    createLogger({ write: (l) => lines.push(l) }).log("info", "test", "hello", { correlationId: "c1", token: "t" })
    const entry = JSON.parse(lines[0]!)
    expect(entry).toMatchObject({ level: "info", service: "opencode-delegate", component: "test", msg: "hello", correlationId: "c1", token: "[redacted]" })
    expect(typeof entry.ts).toBe("string")
  })

  test("drops lines below the minimum level", () => {
    const lines: string[] = []
    createLogger({ minLevel: "warn", write: (l) => lines.push(l) }).log("info", "t", "x")
    expect(lines).toHaveLength(0)
  })
})

describe("opencode api", () => {
  test("sends basic auth, directory and correlation id", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined
    const fake = (async (url: URL, init: RequestInit) => {
      seen = { url: String(url), headers: init.headers as Record<string, string> }
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 })
    }) as unknown as typeof fetch
    const api = createApi({ baseUrl: "http://127.0.0.1:1", password: "pw" }, fake)
    const res = await api.call<{ ok: number }>({ path: "/mcp", directory: "/sessions/a b", correlationId: "c9" })
    expect(res.data).toEqual({ ok: 1 })
    expect(seen!.url).toBe("http://127.0.0.1:1/mcp?directory=%2Fsessions%2Fa+b")
    expect(seen!.headers.authorization).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"))
    expect(seen!.headers["x-correlation-id"]).toBe("c9")
  })

  test("maps a network failure to server_down", async () => {
    const fake = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const api = createApi({ baseUrl: "http://127.0.0.1:1", password: "pw" }, fake)
    await expect(api.call({ path: "/path" })).rejects.toMatchObject({ code: "server_down" })
  })

  test("maps 401 to server_down without leaking the password", async () => {
    const fake = (async () => new Response("", { status: 401 })) as unknown as typeof fetch
    const api = createApi({ baseUrl: "http://127.0.0.1:1", password: "s3cret" }, fake)
    const error = await api.call({ path: "/path" }).catch((e: DelegateError) => e)
    expect(error).toBeInstanceOf(DelegateError)
    expect(JSON.stringify((error as DelegateError).toResult())).not.toContain("s3cret")
  })

  test("expectOk throws upstream_error on non-2xx", () => {
    expect(() => expectOk({ status: 500, data: {} }, "list")).toThrow(DelegateError)
    expect(expectOk({ status: 200, data: { a: 1 } }, "list")).toEqual({ a: 1 })
  })
})

describe("config", () => {
  test("allow policy only admits Keystone /mcp/dynamic and /mcp/c/<id>", () => {
    const policy = JSON.parse(mcpAllowPolicy(defaultConfig({})))
    const rule = policy.remote[0]
    expect(rule.origin).toBe("https://identity.alterspective.com.au")
    const re = new RegExp(rule.path)
    expect(re.test("/mcp/dynamic")).toBe(true)
    expect(re.test("/mcp/c/rag-global")).toBe(true)
    expect(re.test("/api/mcp")).toBe(false)
    expect(re.test("/mcp/c/../x")).toBe(false)
  })
})
