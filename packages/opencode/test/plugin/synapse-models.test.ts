import { describe, expect, test } from "bun:test"
import type { Config } from "@opencode-ai/plugin"
import {
  SYNAPSE_AUTO_MODEL,
  SYNAPSE_DEFAULT_CONTEXT,
  SYNAPSE_DEFAULT_OUTPUT,
  loadSynapseModels,
  parseSynapseModelList,
  synapseModelsUrl,
  type SynapseModelsFetch,
  type SynapseModelsLogEvent,
} from "../../src/plugin/synapse-models"
import { SynapseAuthPlugin } from "../../src/plugin/synapse"

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

function deps(fetchImpl: SynapseModelsFetch, logs: SynapseModelsLogEvent[], token?: string) {
  return {
    fetch: fetchImpl,
    readStoredToken: async () => token,
    log: (event: SynapseModelsLogEvent) => logs.push(event),
    defaultBaseURL: "https://default.example.test/v1",
  }
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

  test("SynapseAuthPlugin's config hook loads the live list with the stored token", async () => {
    const previousFetch = globalThis.fetch
    const previousAuth = process.env.OPENCODE_AUTH_CONTENT
    const calls: Call[] = []
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ synapse: { type: "api", key: TOKEN } })
    const recorder = okFetch(LIVE_REPLY, calls)
    const stub = async (url: RequestInfo | URL, init?: RequestInit) =>
      recorder(typeof url === "string" ? url : url instanceof URL ? url.href : url.url, init ?? {})
    globalThis.fetch = Object.assign(stub, { preconnect: previousFetch.preconnect })
    try {
      const hooks = await SynapseAuthPlugin({
        client: {} as never,
        project: {} as never,
        directory: "",
        worktree: "",
        experimental_workspace: { register() {} },
        serverUrl: new URL("https://example.com"),
        $: {} as never,
      })
      const cfg = configWithStaleModels()
      await hooks.config?.(cfg)
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe(`${BASE}/models`)
      expect(calls[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
      expect(Object.keys(cfg.provider?.synapse?.models ?? {})).toContain("claude-opus-5")
      expect(Object.keys(cfg.provider?.synapse?.models ?? {})).toContain(SYNAPSE_AUTO_MODEL)
    } finally {
      globalThis.fetch = previousFetch
      if (previousAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
      else process.env.OPENCODE_AUTH_CONTENT = previousAuth
    }
  })

  test("still loads when OPENCODE_DISABLE_MODELS_FETCH is set (that flag only gates models.dev)", async () => {
    const previous = process.env.OPENCODE_DISABLE_MODELS_FETCH
    process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"
    try {
      const cfg = configWithStaleModels()
      const calls: Call[] = []
      const result = await loadSynapseModels(cfg, deps(okFetch(LIVE_REPLY, calls), [], TOKEN))
      expect(result).toBe("live")
      expect(calls).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_DISABLE_MODELS_FETCH
      else process.env.OPENCODE_DISABLE_MODELS_FETCH = previous
    }
  })
})
