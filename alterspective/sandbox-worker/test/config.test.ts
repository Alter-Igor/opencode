import { describe, expect, test } from "bun:test"
import { PRIVACY_TIER, PRIVACY_TIER_ENV, renderConfig, type Manifest } from "../supervisor/config"

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
