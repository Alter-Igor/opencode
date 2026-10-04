import { describe, expect, test } from "bun:test"
import { FALLBACK_MODEL, RESOLVE_PATH, parseResolveBody, resolveModelPolicy, resolveUrl } from "../supervisor/policy"

const request = { url: "https://cas.example.test", repo: "Alterspective-Engine/Some-Repo", taskType: "code" }

type Seen = { url: string; headers: Headers }

/** A fetch stub that records the call and answers with `reply`. */
function stub(reply: () => Response | Promise<Response>) {
  const seen: Seen[] = []
  const fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
    seen.push({ url: url instanceof Request ? url.url : url.toString(), headers: new Headers(init?.headers) })
    return reply()
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

const good = {
  cell: { modelIds: ["qwen3.8-flash", "qwen3.8-27b-dflash2"], residency: "local-only", privacyTier: "local-only" },
  effectivePolicyVersion: "v7",
}

describe("resolveUrl (#102)", () => {
  test("asks for the developer role, the lower-cased repo and the task type", () => {
    const url = resolveUrl(request)
    expect(url.pathname).toBe(RESOLVE_PATH)
    expect(url.searchParams.get("role")).toBe("developer")
    expect(url.searchParams.get("repo")).toBe("alterspective-engine/some-repo")
    expect(url.searchParams.get("taskType")).toBe("code")
  })

  test("leaves taskType out when none is given", () => {
    expect(resolveUrl({ url: "https://cas.example.test", repo: "a/b" }).searchParams.has("taskType")).toBe(false)
  })
})

describe("resolveModelPolicy (#102)", () => {
  test("a good answer gives the models and version from the policy", async () => {
    const { fetch, seen } = stub(() => Response.json(good))
    const policy = await resolveModelPolicy({ request, token: "tok-123", fetch })
    expect(policy).toEqual({
      source: "cas",
      modelIds: ["qwen3.8-flash", "qwen3.8-27b-dflash2"],
      effectivePolicyVersion: "v7",
      residency: "local-only",
      privacyTier: "local-only",
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].headers.get("authorization")).toBe("Bearer tok-123")
  })

  test("no token sends no authorization header", async () => {
    const { fetch, seen } = stub(() => Response.json(good))
    await resolveModelPolicy({ request, fetch })
    expect(seen[0].headers.has("authorization")).toBe(false)
  })

  test("no policy configured fails closed without a call", async () => {
    const { fetch, seen } = stub(() => Response.json(good))
    expect(await resolveModelPolicy({ fetch })).toEqual({
      source: "fallback",
      modelIds: [FALLBACK_MODEL],
      reason: "no policy configured",
    })
    expect(await resolveModelPolicy({ request: { url: "", repo: "a/b" }, fetch })).toMatchObject({ source: "fallback" })
    expect(seen).toHaveLength(0)
  })

  test("a bad policy url fails closed", async () => {
    const { fetch } = stub(() => Response.json(good))
    expect(await resolveModelPolicy({ request: { url: "not a url", repo: "a/b" }, fetch })).toMatchObject({
      source: "fallback",
      reason: "bad policy url",
    })
  })

  test("CAS unreachable fails closed to auto", async () => {
    const { fetch } = stub(() => Promise.reject(new TypeError("fetch failed")))
    expect(await resolveModelPolicy({ request, fetch })).toEqual({
      source: "fallback",
      modelIds: ["auto"],
      reason: "unreachable: TypeError",
    })
  })

  test("a timeout fails closed to auto", async () => {
    const fetch = ((_url: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as typeof globalThis.fetch
    const policy = await resolveModelPolicy({ request, fetch, timeoutMs: 20 })
    expect(policy).toMatchObject({ source: "fallback", modelIds: ["auto"] })
    if (policy.source === "fallback") expect(policy.reason).toStartWith("unreachable:")
  })

  for (const status of [401, 403, 404, 500, 503]) {
    test(`HTTP ${status} fails closed to auto`, async () => {
      const { fetch } = stub(() => new Response("nope", { status }))
      expect(await resolveModelPolicy({ request, fetch })).toEqual({
        source: "fallback",
        modelIds: ["auto"],
        reason: `HTTP ${status}`,
      })
    })
  }

  test("a body that is not JSON fails closed", async () => {
    const { fetch } = stub(() => new Response("<html>", { status: 200 }))
    expect(await resolveModelPolicy({ request, fetch })).toMatchObject({ source: "fallback", reason: "bad response: not JSON" })
  })

  test("the token is never in a fallback reason", async () => {
    const { fetch } = stub(() => Promise.reject(new Error("secret-token-value")))
    const policy = await resolveModelPolicy({ request, token: "secret-token-value", fetch })
    expect(JSON.stringify(policy)).not.toContain("secret-token-value")
  })
})

describe("parseResolveBody (#102)", () => {
  test("no role pin (empty or missing modelIds) means Synapse routing, still from CAS", () => {
    expect(parseResolveBody({ cell: { modelIds: [] }, effectivePolicyVersion: 3 })).toEqual({
      source: "cas",
      modelIds: ["auto"],
      effectivePolicyVersion: "3",
    })
    expect(parseResolveBody({ cell: {}, effectivePolicyVersion: "v1" })).toMatchObject({ source: "cas", modelIds: ["auto"] })
  })

  test("the cell fields at the top level are accepted", () => {
    expect(parseResolveBody({ modelIds: ["m1"], effectivePolicyVersion: "v2" })).toMatchObject({ source: "cas", modelIds: ["m1"] })
  })

  test("model ids are trimmed", () => {
    expect(parseResolveBody({ cell: { modelIds: [" m1 "] }, effectivePolicyVersion: "v" })).toMatchObject({ modelIds: ["m1"] })
  })

  const bad: [string, unknown][] = [
    ["null", null],
    ["a string", "v1"],
    ["no version", { cell: { modelIds: ["m1"] } }],
    ["a blank version", { cell: { modelIds: ["m1"] }, effectivePolicyVersion: " " }],
    ["a cell that is not an object", { cell: "x", effectivePolicyVersion: "v" }],
    ["modelIds not an array", { cell: { modelIds: "m1" }, effectivePolicyVersion: "v" }],
    ["a blank model id", { cell: { modelIds: ["m1", " "] }, effectivePolicyVersion: "v" }],
    ["a model id with a space", { cell: { modelIds: ["m 1"] }, effectivePolicyVersion: "v" }],
    ["a non-string model id", { cell: { modelIds: [1] }, effectivePolicyVersion: "v" }],
    ["too many model ids", { cell: { modelIds: Array.from({ length: 21 }, (_, i) => `m${i}`) }, effectivePolicyVersion: "v" }],
  ]
  for (const [name, body] of bad) {
    test(`${name} fails closed to auto`, () => {
      expect(parseResolveBody(body)).toMatchObject({ source: "fallback", modelIds: ["auto"] })
    })
  }
})
