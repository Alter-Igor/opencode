import { describe, expect, test } from "bun:test"
import { createLogger, redact, scrub } from "../src/shared/log.ts"
import { createApi, DEFAULT_API_TIMEOUT_MS, expectOk } from "../src/shared/opencode-api.ts"
import { DelegateError, ErrorCode } from "../src/shared/errors.ts"
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

  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
  const secretValues: Array<[string, string]> = [
    ["bearer token", "upstream said: Authorization: Bearer abc123DEF456ghi789"],
    ["basic credential", "sent Basic b3BlbmNvZGU6cHc= to the box"],
    ["sk- key", "key sk-proj-AbC123dEf456GhI789 rejected"],
    ["JWT", `token ${jwt} expired`],
    ["long hex", "secret 0123456789abcdef0123456789abcdef in body"],
    ["random base64", "value Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdI end"],
  ]
  for (const [label, text] of secretValues) {
    test(`scrubs a ${label} from any string field, including detail`, () => {
      const out = redact({ detail: text, note: text })
      for (const value of [out.detail, out.note]) {
        expect(value).toContain("[redacted]")
        for (const piece of ["abc123DEF456ghi789", "b3BlbmNvZGU6cHc", "AbC123dEf456GhI789", "dozjgNryP4J3", "0123456789abcdef0123", "Zm9vYmFyYmF6"]) {
          expect(String(value)).not.toContain(piece)
        }
      }
    })
  }

  test("keeps ordinary text, paths and short ids", () => {
    for (const text of ["Basic authentication failed", "/sessions/some-long-session-key-name-for-tests", "HTTP 502 from /mcp/ks-delegate/auth", "session ses_01 is idle", "C:\\GitHub\\opencode---opencode-mcp-bridge"]) {
      expect(scrub(text)).toBe(text)
    }
    expect(redact({ status: 502, ok: false })).toEqual({ status: 502, ok: false })
  })

  test("the scheme word stays so the log is still readable", () => {
    expect(scrub("Bearer abc123DEF456ghi789")).toBe("Bearer [redacted]")
  })

  test("writes one JSON line with the required fields and never stdout; msg is scrubbed too", () => {
    const lines: string[] = []
    createLogger({ write: (l) => lines.push(l) }).log("info", "test", "got Bearer abc123DEF456ghi789", { correlationId: "c1", token: "t" })
    const entry = JSON.parse(lines[0]!)
    expect(entry).toMatchObject({ level: "info", service: "opencode-delegate", component: "test", msg: "got Bearer [redacted]", correlationId: "c1", token: "[redacted]" })
    expect(typeof entry.ts).toBe("string")
  })

  test("drops lines below the minimum level", () => {
    const lines: string[] = []
    createLogger({ minLevel: "warn", write: (l) => lines.push(l) }).log("info", "t", "x")
    expect(lines).toHaveLength(0)
  })
})

describe("opencode api", () => {
  test("sends basic auth, directory, correlation id and a deadline", async () => {
    let seen: { url: string; headers: Record<string, string>; signal: AbortSignal | null | undefined } | undefined
    const fake = (async (url: URL, init: RequestInit) => {
      seen = { url: String(url), headers: init.headers as Record<string, string>, signal: init.signal }
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 })
    }) as unknown as typeof fetch
    const api = createApi({ baseUrl: "http://127.0.0.1:1", password: "pw" }, fake)
    const res = await api.call<{ ok: number }>({ path: "/mcp", directory: "/sessions/a b", correlationId: "c9" })
    expect(res.data).toEqual({ ok: 1 })
    expect(seen!.url).toBe("http://127.0.0.1:1/mcp?directory=%2Fsessions%2Fa+b")
    expect(seen!.headers.authorization).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"))
    expect(seen!.headers["x-correlation-id"]).toBe("c9")
    expect(seen!.signal).toBeInstanceOf(AbortSignal)
    expect(DEFAULT_API_TIMEOUT_MS).toBe(30_000)
  })

  test("maps a network failure to server_down", async () => {
    const fake = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const api = createApi({ baseUrl: "http://127.0.0.1:1", password: "pw" }, fake)
    await expect(api.call({ path: "/path" })).rejects.toMatchObject({ code: "server_down" })
  })

  // A fetch that never answers until its signal fires, like a hung box. A real hung fetch holds an
  // open socket; this fake holds a timer instead, because nothing else keeps Bun's loop alive while
  // AbortSignal.timeout's (unreferenced) timer runs down.
  const hanging = (async (_url: URL, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const keepAlive = setInterval(() => {}, 10)
      init.signal?.addEventListener("abort", () => {
        clearInterval(keepAlive)
        reject(init.signal?.reason)
      })
    })) as unknown as typeof fetch

  test("a hung server times out as server_down with detail 'timeout' (per-call override)", async () => {
    const api = createApi({ baseUrl: "http://127.0.0.1:1", password: "pw" }, hanging)
    const started = Date.now()
    const error = (await api.call({ path: "/path", timeoutMs: 50 }).catch((e: unknown) => e)) as DelegateError
    expect(error).toBeInstanceOf(DelegateError)
    expect(error.code).toBe("server_down")
    expect(error.detail).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("the client-wide timeout applies when the call sets none", async () => {
    const api = createApi({ baseUrl: "http://127.0.0.1:1", password: "pw" }, hanging, { timeoutMs: 50 })
    await expect(api.call({ path: "/path" })).rejects.toMatchObject({ code: "server_down", detail: "timeout" })
  })

  test("maps 401 to auth_mismatch without leaking the password", async () => {
    const fake = (async () => new Response("", { status: 401 })) as unknown as typeof fetch
    const api = createApi({ baseUrl: "http://127.0.0.1:1", password: "s3cret" }, fake)
    const error = await api.call({ path: "/path" }).catch((e: DelegateError) => e)
    expect(error).toBeInstanceOf(DelegateError)
    expect((error as DelegateError).code).toBe("auth_mismatch")
    expect((error as DelegateError).message).toBe("The delegate server rejected the bridge's credentials.")
    expect(JSON.stringify((error as DelegateError).toResult())).not.toContain("s3cret")
    expect(String((error as DelegateError).detail)).not.toContain("s3cret")
  })

  test("expectOk throws upstream_error on non-2xx", () => {
    expect(() => expectOk({ status: 500, data: {} }, "list")).toThrow(DelegateError)
    expect(expectOk({ status: 200, data: { a: 1 } }, "list")).toEqual({ a: 1 })
  })
})

describe("errors", () => {
  test("codes other modules rely on exist", () => {
    for (const code of ["auth_mismatch", "server_down", "directory_busy", "branch_diverged", "bundle_too_large"]) expect(ErrorCode).toContain(code as (typeof ErrorCode)[number])
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
