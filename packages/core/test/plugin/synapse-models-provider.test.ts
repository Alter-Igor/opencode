import { describe, expect, test } from "bun:test"
import {
  SYNAPSE_AUTO_MODEL,
  SYNAPSE_PROVIDER_ID,
  defaultAutoModel,
  ensureSynapseProviderConfig,
  loadSynapseModels,
  type SynapseModelsFetch,
} from "../../src/plugin/synapse-models"

const BASE = "https://synapse-e2e.example.test/v1"

const LIVE_REPLY = {
  object: "list",
  data: [
    {
      id: "live-model-1",
      capabilities: { ops: ["chat"], tools: true, reasoning: "field" },
      contextWindow: 200_000,
      maxOutput: 32_000,
    },
  ],
}

const okFetch: SynapseModelsFetch = async () =>
  new Response(JSON.stringify(LIVE_REPLY), { status: 200, headers: { "content-type": "application/json" } })

describe("synapse provider model list integration (#74, svc#366)", () => {
  test("the provider list carries the live Synapse models, tiers, roles, and auto beside configured ones", async () => {
    const cfg: any = {
      provider: {
        synapse: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: BASE, apiKey: "test-key" },
          models: { "stale-model": { name: "Stale" } },
        },
      },
    }
    await loadSynapseModels(cfg, {
      defaultBaseURL: BASE,
      userAgent: "opencode/test",
      fetch: okFetch,
      resolveToken: async () => ({ token: "test-key", expired: false }),
    })
    const models = cfg.provider[SYNAPSE_PROVIDER_ID].models
    expect(models).toBeDefined()
    expect(models[SYNAPSE_AUTO_MODEL]).toEqual(defaultAutoModel())
    expect(models["live-model-1"]).toBeDefined()
    expect(models["live-model-1"].limit.context).toBe(200_000)
    expect(models["live-model-1"].limit.output).toBe(32_000)
    expect(models["stale-model"]).toBeDefined()
    expect(models["basic"]).toBeDefined()
    expect(models["premium"]).toBeDefined()
    expect(models["role:developer"]).toBeDefined()
    expect(models["role:ba"]).toBeDefined()
  })

  test("svc#366: a pinned, whitelisted model the gateway's list omits stays in the provider list, and synapse is the only enabled provider", async () => {
    const cfg: any = {
      model: "synapse/pinned-model",
      provider: {
        synapse: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: BASE, apiKey: "test-key" },
          models: { "pinned-model": { name: "pinned-model" } },
          whitelist: ["pinned-model"],
        },
      },
    }
    ensureSynapseProviderConfig(cfg, BASE)
    await loadSynapseModels(cfg, {
      defaultBaseURL: BASE,
      userAgent: "opencode/test",
      fetch: okFetch,
      resolveToken: async () => ({ token: "test-key", expired: false }),
    })
    expect(cfg.enabled_providers).toEqual(["synapse"])
    expect(cfg.provider.synapse.models["pinned-model"]).toBeDefined()
  })
})
