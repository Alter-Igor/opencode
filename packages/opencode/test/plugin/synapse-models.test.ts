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
  type SynapseModelEntry,
  type SynapseModelsCache,
  type SynapseModelsFetch,
  type SynapseModelsLogEvent,
} from "../../src/plugin/synapse-models"
import { SynapseAuthPlugin, resolveSynapseModelsToken } from "../../src/plugin/synapse"
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
    resolveToken: async () => token,
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

describe("resolveSynapseModelsToken", () => {
  const future = Date.now() + 3_600_000
  const freshSynapseJwt = jwt({ aud: "synapse", exp: Math.floor(future / 1000) })

  test("an expired token is refreshed before the fetch", async () => {
    const expired = jwt({ aud: "synapse", exp: Math.floor(Date.now() / 1000) - 60 })
    let refreshed = 0
    const token = await resolveSynapseModelsToken(
      { token: expired, refreshToken: "r-1", expiresAt: Date.now() - 60_000 },
      async () => {
        refreshed++
        return freshSynapseJwt
      },
    )
    expect(refreshed).toBe(1)
    expect(token).toBe(freshSynapseJwt)
  })

  test("an MCP-audience token is exchanged for a Synapse-audience one", async () => {
    const mcpJwt = jwt({ aud: "https://synapse-mcp.example.test/mcp", exp: Math.floor(future / 1000) })
    const token = await resolveSynapseModelsToken(
      { token: mcpJwt, refreshToken: "r-1", expiresAt: future },
      async () => freshSynapseJwt,
    )
    expect(token).toBe(freshSynapseJwt)
  })

  test("a fresh Synapse-audience token is used as is", async () => {
    let refreshed = 0
    const token = await resolveSynapseModelsToken(
      { token: freshSynapseJwt, refreshToken: "r-1", expiresAt: future },
      async () => {
        refreshed++
        return "never"
      },
    )
    expect(refreshed).toBe(0)
    expect(token).toBe(freshSynapseJwt)
  })

  test("when the refresh fails the stored token is used, so the fetch fails over as before", async () => {
    const expired = jwt({ aud: "synapse", exp: Math.floor(Date.now() / 1000) - 60 })
    const token = await resolveSynapseModelsToken(
      { token: expired, refreshToken: "r-1", expiresAt: Date.now() - 60_000 },
      async () => {
        throw new Error("invalid_grant")
      },
    )
    expect(token).toBe(expired)
  })

  test("no credential means no token", async () => {
    expect(await resolveSynapseModelsToken(undefined, async () => "never")).toBeUndefined()
  })
})

describe("SynapseAuthPlugin config hook", () => {
  test("refreshes an expired stored token, persists it, and loads the live list", async () => {
    const previousFetch = globalThis.fetch
    const previousAuth = process.env.OPENCODE_AUTH_CONTENT
    const expired = jwt({ aud: "synapse", exp: Math.floor(Date.now() / 1000) - 60 })
    const fresh = jwt({ aud: "synapse", exp: Math.floor(Date.now() / 1000) + 3600 })
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      synapse: { type: "api", key: expired, metadata: { refreshToken: "r-1", expiresAt: String(Date.now() - 1000) } },
    })
    const calls: Call[] = []
    const persisted: unknown[] = []
    const stub = async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
      calls.push({ url: href, headers: new Headers(init?.headers) })
      if (href.endsWith("/token")) {
        return Response.json({ access_token: fresh, refresh_token: "r-2", expires_in: 3600 })
      }
      return Response.json(LIVE_REPLY)
    }
    globalThis.fetch = Object.assign(stub, { preconnect: previousFetch.preconnect })
    try {
      const hooks = await SynapseAuthPlugin(
        {
          client: { auth: { set: async (body: unknown) => persisted.push(body) } } as never,
          project: {} as never,
          directory: "",
          worktree: "",
          experimental_workspace: { register() {} },
          serverUrl: new URL("https://example.com"),
          $: {} as never,
        },
        { tokenUrl: "https://keystone.example.test/token" },
      )
      const cfg = configWithStaleModels()
      await hooks.config?.(cfg)
      const modelsCall = calls.find((c) => c.url === `${BASE}/models`)
      expect(modelsCall?.headers.get("authorization")).toBe(`Bearer ${fresh}`)
      expect(Object.keys(cfg.provider?.synapse?.models ?? {})).toContain("claude-opus-5")
      expect(Object.keys(cfg.provider?.synapse?.models ?? {})).toContain(SYNAPSE_AUTO_MODEL)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(JSON.stringify(persisted)).toContain("r-2")
    } finally {
      globalThis.fetch = previousFetch
      if (previousAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
      else process.env.OPENCODE_AUTH_CONTENT = previousAuth
    }
  })
})

describe("Synapse credential refresh shared by startup and chat", () => {
  type Harness = {
    grants: string[]
    chatAuth: (string | null)[]
    run: () => Promise<{ config: Promise<void>; chat: () => Promise<void> }>
    restore: () => void
  }

  function harness(opts: { save: (body: unknown) => Promise<unknown>; tokenDelayMs?: number; hangToken?: boolean }) {
    const previousFetch = globalThis.fetch
    const previousAuth = process.env.OPENCODE_AUTH_CONTENT
    const nonce = Math.random().toString(36).slice(2)
    const expired = jwt({ aud: "synapse", exp: Math.floor(Date.now() / 1000) - 60, jti: `old-${nonce}` })
    const fresh = jwt({ aud: "synapse", exp: Math.floor(Date.now() / 1000) + 3600, jti: `new-${nonce}` })
    const stored = {
      type: "api",
      key: expired,
      metadata: { refreshToken: `r-1-${nonce}`, expiresAt: String(Date.now() - 1000) },
    }
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ synapse: stored })
    const h: Harness & { fresh: string } = {
      fresh,
      grants: [],
      chatAuth: [],
      restore: () => {
        globalThis.fetch = previousFetch
        if (previousAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
        else process.env.OPENCODE_AUTH_CONTENT = previousAuth
      },
      run: async () => {
        const hooks = await SynapseAuthPlugin(
          {
            client: { auth: { set: opts.save } } as never,
            project: {} as never,
            directory: "",
            worktree: "",
            experimental_workspace: { register() {} },
            serverUrl: new URL("https://example.com"),
            $: {} as never,
          },
          { tokenUrl: "https://keystone.example.test/token" },
        )
        const loaded = await hooks.auth?.loader?.(async () => stored as never, {} as never)
        const chatFetch = loaded?.fetch as (url: string, init: RequestInit) => Promise<Response>
        return {
          config: hooks.config?.(configWithStaleModels()) ?? Promise.resolve(),
          chat: async () => {
            await chatFetch(`${BASE}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
            })
          },
        }
      },
    }
    const stub = async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
      if (href.endsWith("/token")) {
        if (opts.hangToken) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("token request aborted")))
          })
        }
        h.grants.push(String(new URLSearchParams(String(init?.body)).get("refresh_token")))
        await new Promise((resolve) => setTimeout(resolve, opts.tokenDelayMs ?? 30))
        return Response.json({ access_token: fresh, refresh_token: `r-2-${nonce}`, expires_in: 3600 })
      }
      if (href.endsWith("/chat/completions")) {
        h.chatAuth.push(new Headers(init?.headers).get("authorization"))
        return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] })
      }
      if (href.endsWith("/models")) {
        const auth = new Headers(init?.headers).get("authorization")
        return auth === `Bearer ${fresh}` ? Response.json(LIVE_REPLY) : new Response("unauthorized", { status: 401 })
      }
      return previousFetch(url, init)
    }
    globalThis.fetch = Object.assign(stub, { preconnect: previousFetch.preconnect })
    return h
  }

  test("a chat request during the startup refresh joins it: exactly one refresh grant", async () => {
    const saved: unknown[] = []
    const h = harness({ save: async (body) => saved.push(body), tokenDelayMs: 50 })
    try {
      const { config, chat } = await h.run()
      await Promise.all([config, chat()])
      await chat()
      expect(h.grants).toHaveLength(1)
      expect(h.chatAuth).toEqual([`Bearer ${h.fresh}`, `Bearer ${h.fresh}`])
      expect(saved).toHaveLength(1)
    } finally {
      h.restore()
    }
  })

  test("a failed save keeps the new token in memory: no second grant with the spent refresh token", async () => {
    const h = harness({
      save: async () => {
        throw new Error("server not ready")
      },
    })
    try {
      const { config, chat } = await h.run()
      await config
      await chat()
      await chat()
      expect(h.grants).toHaveLength(1)
      expect(h.chatAuth).toEqual([`Bearer ${h.fresh}`, `Bearer ${h.fresh}`])
    } finally {
      h.restore()
    }
  })

  test("an unreachable Keystone does not stall startup past the refresh timeout", async () => {
    const h = harness({ save: async () => undefined, hangToken: true })
    try {
      const { config } = await h.run()
      const started = Date.now()
      await config
      expect(Date.now() - started).toBeLessThan(SYNAPSE_MODELS_TIMEOUT_MS * 2 + 1_000)
      expect(h.grants).toHaveLength(0)
    } finally {
      h.restore()
    }
  })
})
