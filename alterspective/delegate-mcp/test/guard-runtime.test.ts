// T2.2 — runtime guard before each send (technical-design §3.5). Fails closed.
import { describe, expect, test } from "bun:test"
import { checkRuntime } from "../src/guard/runtime.ts"
import { DelegateError } from "../src/shared/errors.ts"
import type { OpencodeApi } from "../src/shared/opencode-api.ts"

type Seen = { path: string; directory: string | undefined; method: string | undefined }

function fakeApi(reply: () => { status: number; data: unknown } | Promise<never>, seen: Seen[] = []): OpencodeApi {
  return {
    async call<T>(input: { path: string; directory?: string; method?: string }) {
      seen.push({ path: input.path, directory: input.directory, method: input.method })
      const result = await reply()
      return result as { status: number; data: T | undefined }
    },
  }
}

const ok = (data: unknown) => () => ({ status: 200, data })

describe("checkRuntime", () => {
  test("asks GET /mcp for the session directory", async () => {
    const seen: Seen[] = []
    await checkRuntime(fakeApi(ok({ "ks-delegate": { status: "connected" } }), seen), "/sessions/abc")
    expect(seen).toEqual([{ path: "/mcp", directory: "/sessions/abc", method: undefined }])
  })

  test("passes when every entry is ks-*", async () => {
    const data = { "ks-delegate": { status: "connected" }, "ks-abc123": { status: "needs_auth" } }
    expect(await checkRuntime(fakeApi(ok(data)), "/sessions/a")).toEqual({ ok: true })
  })

  test("passes with no entries", async () => {
    expect(await checkRuntime(fakeApi(ok({})), "/sessions/a")).toEqual({ ok: true })
  })

  test("a non-ks entry is a policy_violation naming it", async () => {
    const data = { "ks-delegate": { status: "connected" }, "evil-rag": { status: "failed", error: "blocked" } }
    const verdict = await checkRuntime(fakeApi(ok(data)), "/sessions/a")
    expect(verdict).toMatchObject({ ok: false, code: "policy_violation" })
    if (!verdict.ok) expect(verdict.reason).toContain("evil-rag")
  })

  test("a look-alike ks name (upper case) is a policy_violation", async () => {
    const verdict = await checkRuntime(fakeApi(ok({ "KS-delegate": { status: "connected" } })), "/sessions/a")
    expect(verdict).toMatchObject({ ok: false, code: "policy_violation" })
  })

  const unverified: Array<[string, () => { status: number; data: unknown } | Promise<never>]> = [
    ["read failure (server_down)", () => Promise.reject(new DelegateError("server_down", "down", "retry"))],
    ["read failure (plain error)", () => Promise.reject(new Error("boom"))],
    ["HTTP 500", () => ({ status: 500, data: { "ks-delegate": { status: "connected" } } })],
    ["HTTP 404", () => ({ status: 404, data: undefined })],
    ["HTTP 302", () => ({ status: 302, data: {} })],
    ["body is not JSON", () => ({ status: 200, data: undefined })],
    ["body is null", () => ({ status: 200, data: null })],
    ["body is an array", () => ({ status: 200, data: [{ name: "ks-delegate" }] })],
    ["body is a string", () => ({ status: 200, data: "ks-delegate" })],
    ["entry value not an object", () => ({ status: 200, data: { "ks-delegate": "connected" } })],
    ["entry without a status", () => ({ status: 200, data: { "ks-delegate": {} } })],
  ]

  for (const [label, reply] of unverified) {
    test(`${label} → policy_unverified`, async () => {
      expect(await checkRuntime(fakeApi(reply), "/sessions/a")).toMatchObject({ ok: false, code: "policy_unverified" })
    })
  }

  test("an empty directory is refused without calling the server (review M5)", async () => {
    const seen: Seen[] = []
    const verdict = await checkRuntime(fakeApi(ok({}), seen), "")
    expect(verdict).toMatchObject({ ok: false, code: "policy_unverified" })
    expect(seen).toHaveLength(0)
  })
})
