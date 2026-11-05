import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { SynapseProviderPlugin } from "@opencode/core/plugin/provider/synapse"
import { Provider } from "@opencode/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "test")
  yield* SynapseProviderPlugin.effect(host)
})

describe("SynapseProviderPlugin", () => {
  test("is registered after OpencodePlugin in ProviderPlugins so OOB fallback restriction applies", () => {
    const ids = ProviderPlugins.map((item) => item.id)
    expect(ids).toContain("opencode.provider.synapse")
    expect(ids.indexOf("opencode.provider.synapse")).toBeGreaterThan(ids.indexOf("opencode.provider.opencode"))
  })

  it.effect(
    "sets synapse/auto as default model, restricts unconnected OOB opencode public fallback, and allows connecting fallback providers in /connect",
    () =>
      Effect.gen(function* () {
        const providers = yield* Provider.Service
        const models = yield* Model.Service
        const integrations = yield* Integration.Service

        // Simulate catalog providers: unconnected opencode public fallback + unconnected anthropic fallback
        yield* integrations.transform((editor) => {
          editor.update(Integration.ID.make("opencode"), (item) => {
            item.name = "OpenCode Console"
          })
          editor.method.update({
            integrationID: Integration.ID.make("opencode"),
            method: { type: "key", label: "API key" },
          })
          editor.update(Integration.ID.make("anthropic"), (item) => {
            item.name = "Anthropic"
          })
          editor.method.update({
            integrationID: Integration.ID.make("anthropic"),
            method: { type: "key", label: "API key" },
          })
        })
        yield* providers.transform((catalog) => {
          catalog.update(Provider.ID.opencode, (provider) => {
            provider.name = "OpenCode Zen"
            provider.activation = "enabled"
            provider.settings = { apiKey: "public" }
            provider.integrationID = Integration.ID.make("opencode")
          })
          catalog.models.update(Provider.ID.opencode, Model.ID.make("big-pickle"), (model) => {
            model.name = "Big Pickle"
            model.time = { released: 999_999_999_999 }
          })
          catalog.update(Provider.ID.anthropic, (provider) => {
            provider.name = "Anthropic"
            provider.activation = "auto"
            provider.integrationID = Integration.ID.make("anthropic")
          })
          catalog.models.update(Provider.ID.anthropic, Model.ID.make("claude-sonnet-4-5"), (model) => {
            model.name = "Claude Sonnet 4.5"
            model.time = { released: 999_999_999_999 }
          })
        })

        yield* addPlugin()

        // 1) Out of the box: only synapse is active; unconnected opencode public fallback is restricted
        const initialAvailable = yield* providers.available()
        expect(initialAvailable.map((p) => p.id)).toEqual([Provider.ID.make("synapse")])

        // 2) Default model out of the box is synapse/auto
        const defaultModel = yield* models.default()
        expect(defaultModel?.providerID).toBe(Provider.ID.make("synapse"))
        expect(defaultModel?.id).toBe(Model.ID.make("auto"))

        // 3) Fallback providers remain selectable in /connect
        const listedIntegrations = yield* integrations.list()
        expect(listedIntegrations.map((i) => i.id)).toContain(Integration.ID.make("synapse"))
        expect(listedIntegrations.map((i) => i.id)).toContain(Integration.ID.make("anthropic"))
        expect(listedIntegrations.map((i) => i.id)).toContain(Integration.ID.make("opencode"))

        // 4) Connecting a fallback provider in /connect activates it while keeping synapse/auto as default
        yield* integrations.connection.key({
          integrationID: Integration.ID.make("anthropic"),
          key: "sk-ant-fallback-test",
        })
        const afterFallbackConnect = yield* providers.available()
        expect(afterFallbackConnect.map((p) => p.id)).toContain(Provider.ID.make("synapse"))
        expect(afterFallbackConnect.map((p) => p.id)).toContain(Provider.ID.anthropic)
        expect((yield* models.default())?.providerID).toBe(Provider.ID.make("synapse"))
        expect((yield* models.default())?.id).toBe(Model.ID.make("auto"))

        // 5) Connecting synapse via /connect updates the Synapse provider apiKey
        yield* integrations.connection.key({
          integrationID: Integration.ID.make("synapse"),
          key: "sk-synapse-connected-key",
        })
        let synapseProvider = yield* providers.get(Provider.ID.make("synapse"))
        for (let attempt = 0; attempt < 50; attempt++) {
          if (synapseProvider?.settings?.apiKey === "sk-synapse-connected-key") break
          yield* Effect.yieldNow
          synapseProvider = yield* providers.get(Provider.ID.make("synapse"))
        }
        expect(synapseProvider?.settings?.apiKey).toBe("sk-synapse-connected-key")
      }),
  )
})
