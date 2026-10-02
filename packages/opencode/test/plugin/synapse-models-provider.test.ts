// End to end through the real Plugin and Provider services: the Synapse plugin's
// config hook must run before core reads cfg.provider, so the provider list shows
// the gateway's models (plus auto) instead of the hand-typed ones.
import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "../../src/provider/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Provider.node))
const SYNAPSE = ProviderV2.ID.make("synapse")
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

const withGateway = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = globalThis.fetch
      const stub = async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
        if (href === `${BASE}/models`) return Response.json(LIVE_REPLY)
        return previous(url, init)
      }
      globalThis.fetch = Object.assign(stub, { preconnect: previous.preconnect })
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        globalThis.fetch = previous
      }),
  )

it.instance(
  "the provider list carries the live Synapse models and auto, not the stale config list",
  () =>
    withGateway(
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        const synapse = providers[SYNAPSE]
        expect(synapse).toBeDefined()
        expect(Object.keys(synapse.models).sort()).toEqual(["auto", "live-model-1"])
        expect(synapse.models["live-model-1"].limit.context).toBe(200_000)
        expect(synapse.models["live-model-1"].limit.output).toBe(32_000)
      }),
    ),
  {
    config: {
      provider: {
        synapse: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: BASE, apiKey: "test-key" },
          models: { "stale-model": { name: "Stale" } },
        },
      },
    },
  },
)
