import { describe, expect, test } from "bun:test"
import { PRIVACY_TIER, PRIVACY_TIER_ENV, resolvePrivacyTier, renderConfig, serveEnv, type Manifest } from "../supervisor/config"

const manifest = (headers?: Record<string, string>): Manifest => ({
  taskId: "sbxw-test",
  model: { baseURL: "https://gateway.example.test/v1", headers },
})

describe("renderConfig (#101)", () => {
  test("the synapse provider always sends x-privacy-tier: local-only", () => {
    expect(PRIVACY_TIER).toBe("local-only")
    expect(PRIVACY_TIER_ENV).toBe("SYNAPSE_PRIVACY_TIER")
    expect(renderConfig(manifest(), ["auto"]).provider.synapse.options.headers).toEqual({ "x-privacy-tier": "local-only" })
  })

  test("manifest headers are kept, but cannot remove or widen the tier in any spelling", () => {
    const headers = renderConfig(manifest({ "x-task-type": "code", "X-Privacy-Tier": "cloud-ok", "x-privacy-tier": "" }), ["auto"])
      .provider.synapse.options.headers
    expect(headers).toEqual({ "x-task-type": "code", "x-privacy-tier": "local-only" })
  })

  test("only the synapse provider is enabled", () => {
    const config = renderConfig(manifest(), ["auto"])
    expect(config.enabled_providers).toEqual(["synapse"])
    expect(Object.keys(config.provider)).toEqual(["synapse"])
  })
})

describe("resolvePrivacyTier (#161)", () => {
  test("only the exact string cloud-ok resolves to cloud-ok", () => {
    expect(resolvePrivacyTier({ privacyTier: "cloud-ok" })).toBe("cloud-ok")
  })

  test("everything else, including look-alikes, is local-only", () => {
    for (const privacyTier of [undefined, null, "local-only", "Cloud-OK", " cloud-ok", {}, ["cloud-ok"]]) {
      expect(resolvePrivacyTier({ privacyTier })).toBe("local-only")
    }
  })
})

describe("renderConfig privacy tier (#161)", () => {
  test("privacyTier cloud-ok is honoured exactly", () => {
    expect(renderConfig({ ...manifest(), privacyTier: "cloud-ok" }, ["auto"]).provider.synapse.options.headers).toEqual({
      "x-privacy-tier": "cloud-ok",
    })
  })

  test("mixed-case manifest tier headers cannot widen or duplicate the resolved local tier", () => {
    const headers = renderConfig(
      manifest({ "X-Privacy-Tier": "cloud-ok", "x-privacy-tier": "cloud-ok" }),
      ["auto"],
    ).provider.synapse.options.headers
    expect(headers).toEqual({ "x-privacy-tier": "local-only" })
  })

  test("a cloud modelPolicy with no privacyTier stays local-only", () => {
    const cloud: Manifest = {
      ...manifest(),
      model: { baseURL: "https://gateway.example.test/v1", onPremDefault: ["cloud-model"] },
      modelPolicy: { cell: { modelIds: ["cloud-model"], residency: "cloud-ok", privacyTier: "cloud-ok" }, effectivePolicyVersion: "v1" },
    }
    expect(renderConfig(cloud, ["cloud-model"]).provider.synapse.options.headers).toEqual({ "x-privacy-tier": "local-only" })
  })

  test("privacyTier cloud-ok survives manifest header stripping", () => {
    const config = renderConfig({ ...manifest({ "x-privacy-tier": "local-only" }), privacyTier: "cloud-ok" }, ["auto"])
    expect(config.provider.synapse.options.headers["x-privacy-tier"]).toBe("cloud-ok")
  })
})

describe("serveEnv (#161)", () => {
  test("an inherited SYNAPSE_PRIVACY_TIER cannot override a local tier", () => {
    const env = serveEnv({ PATH: "/usr/bin", SYNAPSE_PRIVACY_TIER: "cloud-ok", SBXW_MANIFEST: "{}", SBXW_SERVER_PASSWORD: "p" }, "local-only")
    expect(env[PRIVACY_TIER_ENV]).toBe("local-only")
    expect(env.SBXW_MANIFEST).toBeUndefined()
    expect(env.SBXW_SERVER_PASSWORD).toBeUndefined()
    expect(env.PATH).toBe("/usr/bin")
  })

  test("the tier is set exactly once from the manifest resolution", () => {
    expect(serveEnv({ SYNAPSE_PRIVACY_TIER: "local-only", OTHER: "x" }, "cloud-ok")[PRIVACY_TIER_ENV]).toBe("cloud-ok")
  })
})

describe("renderConfig model ids (#102)", () => {
  test("strongest last: the last id is the main model, the first the small model", () => {
    const config = renderConfig(manifest(), ["qwen3.8-flash", "qwen3.8-27b-dflash2"])
    expect(config.model).toBe("synapse/qwen3.8-27b-dflash2")
    expect(config.small_model).toBe("synapse/qwen3.8-flash")
    expect(Object.keys(config.provider.synapse.models)).toEqual(["qwen3.8-flash", "qwen3.8-27b-dflash2"])
  })

  test("the box offers only the models in the policy", () => {
    expect(renderConfig(manifest(), ["a", "b"]).provider.synapse.whitelist).toEqual(["a", "b"])
  })

  test("one id is both models", () => {
    const config = renderConfig(manifest(), ["auto"])
    expect(config.model).toBe("synapse/auto")
    expect(config.small_model).toBe("synapse/auto")
  })

  test("no model ids is refused", () => {
    expect(() => renderConfig(manifest(), [])).toThrow()
  })
})
