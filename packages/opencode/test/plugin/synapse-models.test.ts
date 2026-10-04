import { describe, expect, test } from "bun:test"
import type { Config } from "@opencode-ai/plugin"
import {
  SYNAPSE_AUTO_MODEL,
  SYNAPSE_DEFAULT_CONTEXT,
  SYNAPSE_DEFAULT_OUTPUT,
  SYNAPSE_MODELS_TIMEOUT_MS,
  createSynapseModelsFailureLogger,
  fileSynapseModelsCache,
  loadSynapseModels,
  parseSynapseModelList,
  readStoredSynapseCredential,
  synapseModelsUrl,
  updateSynapseModelsCache,
  type SynapseModelEntry,
  type SynapseModelsCache,
  type SynapseModelsFetch,
  type SynapseModelsLogEvent,
} from "../../src/plugin/synapse-models"
import { SynapseAuthPlugin, synapseModelsToken, synapseRefreshLockKey, type SynapseRefreshLock } from "../../src/plugin/synapse"
import { Flock } from "@opencode-ai/core/util/flock"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

const BASE = "https://synapse.example.test/v1"
const TOKEN = "sk-live-token-value-1234567890"

// Shape observed from the live gateway's GET /v1/models on 2026-10-02.
const LIVE_REPLY = {
  object: "list",
  data: [
    {
      id: "claude-opus-5",
      object: "model",
      capabilities: { ops: ["chat"], tools: true, reasoning: "field" },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
    {
      id: "qwen/qwen3.8-flash",
      object: "model",
      capabilities: { ops: ["chat"], tools: true, reasoning: "none" },
      contextWindow: 1_000_000,
      maxOutput: 16_384,
    },
    { id: "bare-model", object: "model" },
    { id: "embed-only", object: "model", capabilities: { ops: ["embed"] } },
  ],
}

type Call = { url: string; headers: Headers }

function okFetch(body: unknown, calls: Call[]): SynapseModelsFetch {
  return async (url, init) => {
    calls.push({ url, headers: new Headers(init.headers) })
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }
}

function failingFetch(calls: Call[], status = 503): SynapseModelsFetch {
  return async (url, init) => {
    calls.push({ url, headers: new Headers(init.headers) })
    return new Response(`upstream error for ${TOKEN}`, { status })
  }
}

function configWithStaleModels(): Config {
  return {
    provider: {
      synapse: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: BASE },
        models: {
          "stale-model-a": { name: "Stale A" },
          "stale-model-b": { name: "Stale B" },
        },
      },
    },
  }
}

function synapseOf(cfg: Config) {
  const provider = cfg.provider?.synapse
  if (!provider) throw new Error("test config has no synapse provider")
  return provider
}

function memoryCache(seed: Record<string, Record<string, SynapseModelEntry>> = {}): SynapseModelsCache & {
  store: Record<string, Record<string, SynapseModelEntry>>
} {
  const store = { ...seed }
  return {
    store,
    read: async (baseURL) => store[baseURL],
    write: async (baseURL, models) => {
      store[baseURL] = models
    },
  }
}

function deps(
  fetchImpl: SynapseModelsFetch,
  logs: SynapseModelsLogEvent[],
  token?: string,
  cache: SynapseModelsCache = memoryCache(),
) {
  return {
    fetch: fetchImpl,
    resolveToken: async () => ({ token, expired: false }),
    log: (event: SynapseModelsLogEvent) => logs.push(event),
    defaultBaseURL: "https://default.example.test/v1",
    cache,
  }
}

function jwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  return `${header}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`
}

describe("synapseModelsUrl", () => {
  test("appends /models to a base that already carries /v1, without doubling slashes", () => {
    expect(synapseModelsUrl("https://h.test/v1")).toBe("https://h.test/v1/models")
    expect(synapseModelsUrl("https://h.test/v1/")).toBe("https://h.test/v1/models")
  })
})

describe("parseSynapseModelList", () => {
  test("maps limits and capabilities, applies defaults, and skips non-chat models", () => {
    const models = parseSynapseModelList(LIVE_REPLY)
    expect(Object.keys(models).sort()).toEqual(["bare-model", "claude-opus-5", "qwen/qwen3.8-flash"])
    expect(models["claude-opus-5"].limit).toEqual({ context: 1_000_000, output: 128_000 })
    expect(models["claude-opus-5"].tool_call).toBe(true)
    expect(models["claude-opus-5"].reasoning).toBe(true)
    expect(models["qwen/qwen3.8-flash"].reasoning).toBe(false)
    expect(models["bare-model"].limit).toEqual({ context: SYNAPSE_DEFAULT_CONTEXT, output: SYNAPSE_DEFAULT_OUTPUT })
  })

  test("#80: drops models Synapse marks capabilities.tools false; tools absent or true is kept", () => {
    const models = parseSynapseModelList({
      object: "list",
      data: [
        { id: "claude-opus-5", capabilities: { ops: ["chat"], tools: true } },
        { id: "gemini-3.1-flash-image", capabilities: { ops: ["chat"], tools: false } },
        { id: "qwen/qwen3.8-flash", capabilities: { ops: ["chat"] } },
        { id: "no-caps" },
      ],
    })
    expect(Object.keys(models).sort()).toEqual(["claude-opus-5", "no-caps", "qwen/qwen3.8-flash"])
  })

  test("returns an empty record for a reply that is not a model list", () => {
    expect(parseSynapseModelList({ error: "nope" })).toEqual({})
    expect(parseSynapseModelList(null)).toEqual({})
  })
})

describe("loadSynapseModels", () => {
  test("success replaces the hand-typed list with the live list and always offers auto", async () => {
    const cfg = configWithStaleModels()
    const calls: Call[] = []
    const logs: SynapseModelsLogEvent[] = []
    const result = await loadSynapseModels(cfg, deps(okFetch(LIVE_REPLY, calls), logs, TOKEN))

    expect(result).toBe("live")
    const models = cfg.provider?.synapse?.models ?? {}
    expect(Object.keys(models).sort()).toEqual(
      ["bare-model", "claude-opus-5", "qwen/qwen3.8-flash", SYNAPSE_AUTO_MODEL].sort(),
    )
    expect(models["stale-model-a"]).toBeUndefined()
    expect(models[SYNAPSE_AUTO_MODEL]).toBeDefined()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE}/models`)
    expect(logs).toHaveLength(0)
  })

  test("request carries the Synapse auth headers when a token is available", async () => {
    const cfg = configWithStaleModels()
    const calls: Call[] = []
    await loadSynapseModels(cfg, deps(okFetch(LIVE_REPLY, calls), [], TOKEN))
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(calls[0].headers.get("x-api-key")).toBe(TOKEN)
  })

  test("a configured apiKey is used when no token is stored", async () => {
    const cfg = configWithStaleModels()
    synapseOf(cfg).options = { baseURL: BASE, apiKey: "cfg-key-abcdefgh" }
    const calls: Call[] = []
    await loadSynapseModels(cfg, deps(okFetch(LIVE_REPLY, calls), [], undefined))
    expect(calls[0].headers.get("authorization")).toBe("Bearer cfg-key-abcdefgh")
  })

  test("without any token the request is still attempted, with no auth header", async () => {
    const cfg = configWithStaleModels()
    const calls: Call[] = []
    const result = await loadSynapseModels(cfg, deps(okFetch(LIVE_REPLY, calls), [], undefined))
    expect(result).toBe("live")
    expect(calls).toHaveLength(1)
    expect(calls[0].headers.get("authorization")).toBeNull()
    expect(calls[0].headers.get("x-api-key")).toBeNull()
  })

  test("uses the default base URL when the provider has none configured", async () => {
    const cfg = configWithStaleModels()
    synapseOf(cfg).options = {}
    const calls: Call[] = []
    await loadSynapseModels(cfg, deps(okFetch(LIVE_REPLY, calls), [], undefined))
    expect(calls[0].url).toBe("https://default.example.test/v1/models")
  })

  test("failure keeps the configured models plus auto and logs once without the token", async () => {
    const cfg = configWithStaleModels()
    const calls: Call[] = []
    const logs: SynapseModelsLogEvent[] = []
    const result = await loadSynapseModels(cfg, deps(failingFetch(calls), logs, TOKEN))

    expect(result).toBe("fallback")
    const models = cfg.provider?.synapse?.models ?? {}
    expect(Object.keys(models).sort()).toEqual(["stale-model-a", "stale-model-b", SYNAPSE_AUTO_MODEL].sort())
    expect(logs).toHaveLength(1)
    expect(JSON.stringify(logs)).not.toContain(TOKEN)
  })

  test("a network error or timeout falls back without throwing", async () => {
    const cfg = configWithStaleModels()
    const logs: SynapseModelsLogEvent[] = []
    const throwing: SynapseModelsFetch = async () => {
      throw new Error(`connect ECONNREFUSED with Bearer ${TOKEN}`)
    }
    const result = await loadSynapseModels(cfg, deps(throwing, logs, TOKEN))
    expect(result).toBe("fallback")
    expect(Object.keys(cfg.provider?.synapse?.models ?? {})).toContain(SYNAPSE_AUTO_MODEL)
    expect(logs).toHaveLength(1)
    expect(JSON.stringify(logs)).not.toContain(TOKEN)
  })

  test("an empty live list is treated as a failure, not as 'no models'", async () => {
    const cfg = configWithStaleModels()
    const logs: SynapseModelsLogEvent[] = []
    const result = await loadSynapseModels(cfg, deps(okFetch({ object: "list", data: [] }, []), logs, TOKEN))
    expect(result).toBe("fallback")
    expect(Object.keys(cfg.provider?.synapse?.models ?? {})).toContain("stale-model-a")
  })

  test("a configured auto entry is kept over the default one", async () => {
    const cfg = configWithStaleModels()
    synapseOf(cfg).models = { auto: { name: "Synapse Auto (custom)" } }
    await loadSynapseModels(cfg, deps(okFetch(LIVE_REPLY, []), [], TOKEN))
    expect(cfg.provider?.synapse?.models?.[SYNAPSE_AUTO_MODEL]?.name).toBe("Synapse Auto (custom)")
  })

  test("does nothing, and makes no request, when no synapse provider is configured", async () => {
    const cfg: Config = { provider: { other: { models: {} } } }
    const calls: Call[] = []
    const result = await loadSynapseModels(cfg, deps(okFetch(LIVE_REPLY, calls), [], TOKEN))
    expect(result).toBe("skipped")
    expect(calls).toHaveLength(0)
    expect(cfg.provider?.synapse).toBeUndefined()
  })

  test("skips the fetch, and sends no credentials, when synapse is in disabled_providers", async () => {
    const cfg = { ...configWithStaleModels(), disabled_providers: ["synapse"] }
    const calls: Call[] = []
    expect(await loadSynapseModels(cfg, deps(okFetch(LIVE_REPLY, calls), [], TOKEN))).toBe("skipped")
    expect(calls).toHaveLength(0)
  })

  test("skips the fetch when enabled_providers excludes synapse", async () => {
    const cfg = { ...configWithStaleModels(), enabled_providers: ["other"] }
    const calls: Call[] = []
    expect(await loadSynapseModels(cfg, deps(okFetch(LIVE_REPLY, calls), [], TOKEN))).toBe("skipped")
    expect(calls).toHaveLength(0)
  })

  test("a slow gateway is abandoned at the timeout and the fallback is used", async () => {
    expect(SYNAPSE_MODELS_TIMEOUT_MS).toBeLessThanOrEqual(2_500)
    const slow: SynapseModelsFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("should have been aborted")), 10_000)
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer)
          reject(new Error("aborted by timeout"))
        })
      })
    const cfg = configWithStaleModels()
    const logs: SynapseModelsLogEvent[] = []
    const started = Date.now()
    const result = await loadSynapseModels(cfg, { ...deps(slow, logs, TOKEN), timeoutMs: 50 })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result).toBe("fallback")
    expect(logs[0]?.error).toContain("aborted")
  })

  test("success writes the last good list to the cache, without any token", async () => {
    const cache = memoryCache()
    await loadSynapseModels(configWithStaleModels(), deps(okFetch(LIVE_REPLY, []), [], TOKEN, cache))
    expect(Object.keys(cache.store[BASE] ?? {})).toContain("claude-opus-5")
    expect(JSON.stringify(cache.store)).not.toContain(TOKEN)
  })

  test("failure uses the cached last good list, plus auto, before the configured list", async () => {
    const cache = memoryCache({ [BASE]: { "cached-model": { name: "cached-model" } } })
    const cfg = configWithStaleModels()
    const result = await loadSynapseModels(cfg, deps(failingFetch([]), [], TOKEN, cache))
    expect(result).toBe("cache")
    expect(Object.keys(cfg.provider?.synapse?.models ?? {}).sort()).toEqual(["cached-model", SYNAPSE_AUTO_MODEL].sort())
  })
})

describe("fileSynapseModelsCache", () => {
  test("round-trips per base URL and survives a missing or corrupt file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-models-cache-"))
    try {
      const file = path.join(dir, "synapse-models.json")
      const cache = fileSynapseModelsCache(file)
      expect(await cache.read(BASE)).toBeUndefined()
      await cache.write(BASE, { "m-1": { name: "m-1" } })
      await cache.write("https://other.test/v1", { "m-2": { name: "m-2" } })
      expect(Object.keys((await cache.read(BASE)) ?? {})).toEqual(["m-1"])
      await fs.writeFile(file, "{not json")
      expect(await cache.read(BASE)).toBeUndefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("createSynapseModelsFailureLogger", () => {
  test("logs each distinct failure once per process, not every startup", () => {
    const sink: SynapseModelsLogEvent[] = []
    const log = createSynapseModelsFailureLogger((event) => sink.push(event), new Set())
    const event: SynapseModelsLogEvent = { reason: "synapse-models-fetch-failed", url: BASE, error: "HTTP 503" }
    log(event)
    log(event)
    log({ ...event, error: "HTTP 401" })
    log({ ...event, url: "https://other.test/v1/models" })
    expect(sink.map((e) => `${e.url} ${e.error}`)).toEqual([
      `${BASE} HTTP 503`,
      `${BASE} HTTP 401`,
      "https://other.test/v1/models HTTP 503",
    ])
  })
})

describe("readStoredSynapseCredential", () => {
  test("falls back to auth.json when OPENCODE_AUTH_CONTENT is not valid JSON, like the Auth service", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-auth-"))
    const previous = process.env.OPENCODE_AUTH_CONTENT
    try {
      const file = path.join(dir, "auth.json")
      await fs.writeFile(
        file,
        JSON.stringify({
          synapse: { type: "api", key: TOKEN, metadata: { refreshToken: "r-1", expiresAt: "1700000000000" } },
        }),
      )
      process.env.OPENCODE_AUTH_CONTENT = "{broken"
      const cred = await readStoredSynapseCredential(file)
      expect(cred?.token).toBe(TOKEN)
      expect(cred?.refreshToken).toBe("r-1")
      expect(cred?.expiresAt).toBe(1_700_000_000_000)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
      else process.env.OPENCODE_AUTH_CONTENT = previous
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("synapseModelsToken", () => {
  const now = Date.now()

  test("no credential: no token, not expired (the request still goes out)", () => {
    expect(synapseModelsToken(undefined, now)).toEqual({ expired: false })
  })

  test("an expired stored expiry or JWT exp marks the token expired", () => {
    expect(synapseModelsToken({ token: "sk-1", expiresAt: now - 1_000 }, now).expired).toBe(true)
    expect(synapseModelsToken({ token: jwt({ exp: Math.floor(now / 1000) - 60 }) }, now).expired).toBe(true)
  })

  test("a fresh JWT or a plain API key with no expiry is used", () => {
    const fresh = jwt({ aud: "synapse", exp: Math.floor(now / 1000) + 3600 })
    expect(synapseModelsToken({ token: fresh, expiresAt: now + 3_600_000 }, now)).toEqual({
      token: fresh,
      expired: false,
    })
    expect(synapseModelsToken({ token: "sk-1" }, now)).toEqual({ token: "sk-1", expired: false })
  })
})

describe("loadSynapseModels with an expired stored token", () => {
  const expiredDeps = (calls: Call[], cache: SynapseModelsCache) => ({
    ...deps(okFetch(LIVE_REPLY, calls), [], TOKEN, cache),
    resolveToken: async () => ({ token: TOKEN, expired: true }),
  })

  test("makes no request and uses the cached list", async () => {
    const calls: Call[] = []
    const cfg = configWithStaleModels()
    const cache = memoryCache({ [BASE]: { "cached-model": { name: "cached-model" } } })
    expect(await loadSynapseModels(cfg, expiredDeps(calls, cache))).toBe("cache")
    expect(calls).toHaveLength(0)
    expect(Object.keys(cfg.provider?.synapse?.models ?? {}).sort()).toEqual([SYNAPSE_AUTO_MODEL, "cached-model"])
  })

  test("makes no request and uses the configured list when there is no cache", async () => {
    const calls: Call[] = []
    const cfg = configWithStaleModels()
    expect(await loadSynapseModels(cfg, expiredDeps(calls, memoryCache()))).toBe("fallback")
    expect(calls).toHaveLength(0)
    expect(Object.keys(cfg.provider?.synapse?.models ?? {})).toContain("stale-model-a")
  })
})

describe("updateSynapseModelsCache", () => {
  test("stores the live list fetched with the new token, and never throws", async () => {
    const calls: Call[] = []
    const cache = memoryCache()
    const target = { baseURL: BASE, headers: {} }
    expect(await updateSynapseModelsCache({ target, token: TOKEN, fetch: okFetch(LIVE_REPLY, calls), cache })).toBe(
      true,
    )
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(Object.keys(cache.store[BASE] ?? {})).toContain("claude-opus-5")
    expect(await updateSynapseModelsCache({ target, token: TOKEN, fetch: failingFetch([]), cache })).toBe(false)
  })
})

describe("Synapse credential refresh (chat only; startup never refreshes)", () => {
  type Opts = {
    save?: (body: unknown) => Promise<unknown>
    tokenDelayMs?: number
    expiresIn?: number
    refreshWaitMs?: number
    refreshLock?: SynapseRefreshLock
    /** Use the plugin's real machine-wide file lock. Other tests use an in-process pass-through. */
    realLock?: boolean
  }

  function harness(opts: Opts) {
    const previousFetch = globalThis.fetch
    const previousAuth = process.env.OPENCODE_AUTH_CONTENT
    const nonce = Math.random().toString(36).slice(2)
    const old = jwt({ aud: "synapse", exp: Math.floor(Date.now() / 1000) - 60, jti: `old-${nonce}` })
    // The stored credential never changes: either every save fails, or
    // OPENCODE_AUTH_CONTENT pins it (it always wins over auth.json).
    const stored = {
      type: "api",
      key: old,
      metadata: { refreshToken: `r-1-${nonce}`, expiresAt: String(Date.now() - 1000) },
    }
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ synapse: stored })
    const grants: string[] = []
    const issued: string[] = []
    const chatAuth: (string | null)[] = []
    const modelsAuth: (string | null)[] = []
    const tokenCalls: string[] = []
    const stub = async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
      const auth = new Headers(init?.headers).get("authorization")
      if (href.endsWith("/token")) {
        tokenCalls.push(href)
        const used = (init?.body instanceof URLSearchParams ? init.body.get("refresh_token") : null) ?? ""
        grants.push(used.replace(`-${nonce}`, ""))
        const n = grants.length
        await new Promise((resolve) => setTimeout(resolve, opts.tokenDelayMs ?? 5))
        const access = jwt({ aud: "synapse", exp: Math.floor(Date.now() / 1000) + 3600, jti: `a-${n}-${nonce}` })
        issued.push(access)
        return Response.json({
          access_token: access,
          refresh_token: `r-${n + 1}-${nonce}`,
          expires_in: opts.expiresIn ?? 3600,
        })
      }
      if (href.endsWith("/chat/completions")) {
        chatAuth.push(auth)
        return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] })
      }
      if (href.endsWith("/models")) {
        modelsAuth.push(auth)
        return Response.json(LIVE_REPLY)
      }
      return previousFetch(url, init)
    }
    globalThis.fetch = Object.assign(stub, { preconnect: previousFetch.preconnect })

    const start = async () => {
      const hooks = await SynapseAuthPlugin(
        {
          client: { auth: { set: opts.save ?? (async () => undefined) } } as never,
          project: {} as never,
          directory: "",
          worktree: "",
          experimental_workspace: { register() {} },
          serverUrl: new URL("https://example.com"),
          $: {} as never,
        },
        { tokenUrl: "https://keystone.example.test/token", refreshWaitMs: opts.refreshWaitMs, refreshLock: opts.realLock ? undefined : (opts.refreshLock ?? ((fn) => fn())) },
      )
      const cfg = configWithStaleModels()
      await hooks.config?.(cfg)
      const loaded = await hooks.auth?.loader?.(async () => stored as never, {} as never)
      const chatFetch: unknown = loaded?.fetch
      if (typeof chatFetch !== "function") throw new Error("auth loader returned no fetch")
      const chat = async () => {
        await chatFetch(`${BASE}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
        })
      }
      return { cfg, chat }
    }

    const restore = () => {
      globalThis.fetch = previousFetch
      if (previousAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
      else process.env.OPENCODE_AUTH_CONTENT = previousAuth
    }
    // #75: what another OpenCode process leaves in the credential file after its own refresh.
    const otherProcessRotated = (opts2: { expired: boolean }) => {
      const exp = Math.floor(Date.now() / 1000) + (opts2.expired ? -60 : 3600)
      const access = jwt({ aud: "synapse", exp, jti: `other-${nonce}` })
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
        synapse: { type: "api", key: access, metadata: { refreshToken: `r-9-${nonce}`, expiresAt: String(exp * 1000) } },
      })
      return access
    }
    return { old, grants, issued, chatAuth, modelsAuth, tokenCalls, start, restore, otherProcessRotated }
  }

  const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

  test("startup with an expired token contacts neither Keystone nor /models", async () => {
    const h = harness({})
    try {
      const { cfg } = await h.start()
      expect(h.tokenCalls).toHaveLength(0)
      expect(h.modelsAuth).toHaveLength(0)
      expect(Object.keys(cfg.provider?.synapse?.models ?? {})).toContain(SYNAPSE_AUTO_MODEL)
    } finally {
      h.restore()
    }
  })

  test("the first chat refreshes once, then the model cache is updated in the background with the new token", async () => {
    const h = harness({})
    try {
      const { chat } = await h.start()
      await chat()
      await settle()
      expect(h.grants).toEqual(["r-1"])
      expect(h.chatAuth).toEqual([`Bearer ${h.issued[0]}`])
      expect(h.modelsAuth).toEqual([`Bearer ${h.issued[0]}`])
    } finally {
      h.restore()
    }
  })

  test("with every save failing, each refresh uses the newest refresh token: r-1, r-2, r-3", async () => {
    const h = harness({
      expiresIn: 1,
      save: async () => {
        throw new Error("server not ready")
      },
    })
    try {
      const { chat } = await h.start()
      await chat()
      await chat()
      await chat()
      expect(h.grants).toEqual(["r-1", "r-2", "r-3"])
      expect(h.chatAuth).toEqual(h.issued.map((token) => `Bearer ${token}`))
    } finally {
      h.restore()
    }
  })

  test("with OPENCODE_AUTH_CONTENT pinning the old credential (saves succeed), still r-1, r-2, r-3", async () => {
    const saved: unknown[] = []
    const h = harness({ expiresIn: 1, save: async (body) => saved.push(body) })
    try {
      const { chat } = await h.start()
      await chat()
      await chat()
      await chat()
      expect(h.grants).toEqual(["r-1", "r-2", "r-3"])
      expect(saved).toHaveLength(3)
    } finally {
      h.restore()
    }
  })

  test("a slow grant that outlives the chat's wait is kept: the next refresh uses its new refresh token", async () => {
    const h = harness({ expiresIn: 1, tokenDelayMs: 150, refreshWaitMs: 20 })
    try {
      const { chat } = await h.start()
      await chat()
      expect(h.chatAuth).toEqual([`Bearer ${h.old}`])
      await settle(250)
      await chat()
      // The second wait also gives up, so that request uses the newest token held in memory.
      expect(h.chatAuth[1]).toBe(`Bearer ${h.issued[0]}`)
      // Poll until the second grant has answered (a grant is recorded when it starts, its token
      // when it ends). Ending earlier would leave it running into the next test, which shares
      // the process-wide refresh state.
      for (let i = 0; i < 100 && h.issued.length < 2; i++) await settle(30)
      await settle(30)
      expect(h.grants).toEqual(["r-1", "r-2"])
    } finally {
      h.restore()
    }
  })

  test("#75: another process refreshed while this one waited for the lock: its token is used, with no grant", async () => {
    const h = harness({ refreshWaitMs: 5_000, realLock: true })
    // Hold the real machine-wide lock, as the other process would during its refresh.
    const held = await Flock.acquire(synapseRefreshLockKey())
    let released = false
    try {
      const { chat } = await h.start()
      const sent = chat()
      await settle(100)
      expect(h.tokenCalls).toHaveLength(0)
      const theirs = h.otherProcessRotated({ expired: false })
      await held.release()
      released = true
      await sent
      expect(h.grants).toEqual([])
      expect(h.chatAuth).toEqual([`Bearer ${theirs}`])
    } finally {
      if (!released) await held.release()
      h.restore()
    }
  })

  test("#75: the other process's token is also expiring: the grant spends its refresh token, never ours", async () => {
    let theirs = ""
    const h = harness({
      refreshLock: async (fn) => {
        theirs = h.otherProcessRotated({ expired: true })
        return fn()
      },
    })
    try {
      const { chat } = await h.start()
      await chat()
      expect(theirs).not.toBe("")
      expect(h.grants).toEqual(["r-9"])
      expect(h.chatAuth).toEqual([`Bearer ${h.issued[0]}`])
    } finally {
      h.restore()
    }
  })

  test("#75: the rotated token is saved before the lock is released", async () => {
    const events: string[] = []
    const h = harness({
      save: async () => {
        await settle(20)
        events.push("saved")
      },
      refreshLock: async (fn) => {
        events.push("locked")
        try {
          return await fn()
        } finally {
          events.push("released")
        }
      },
    })
    try {
      const { chat } = await h.start()
      await chat()
      expect(h.grants).toEqual(["r-1"])
      expect(events).toEqual(["locked", "saved", "released"])
    } finally {
      h.restore()
    }
  })

  test("#75: when the lock cannot be taken the chat goes ahead with its token and nothing is spent", async () => {
    const h = harness({
      refreshLock: async () => {
        throw new Error("Timed out waiting for lock")
      },
    })
    try {
      const { chat } = await h.start()
      await chat()
      expect(h.grants).toEqual([])
      expect(h.chatAuth).toEqual([`Bearer ${h.old}`])
    } finally {
      h.restore()
    }
  })
})
