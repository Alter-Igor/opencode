import { describe, expect, test } from "bun:test"
import { PRIVACY_TIER, PRIVACY_TIER_ENV, renderConfig, type Manifest } from "../supervisor/config"

const manifest = (headers?: Record<string, string>): Manifest => ({
  taskId: "sbxw-test",
  model: { baseURL: "https://gateway.example.test/v1", id: "auto", headers },
})

describe("renderConfig (#101)", () => {
  test("the synapse provider always sends x-privacy-tier: local-only", () => {
    expect(PRIVACY_TIER).toBe("local-only")
    expect(PRIVACY_TIER_ENV).toBe("SYNAPSE_PRIVACY_TIER")
    expect(renderConfig(manifest()).provider.synapse.options.headers).toEqual({ "x-privacy-tier": "local-only" })
  })

  test("manifest headers are kept, but cannot remove or widen the tier in any spelling", () => {
    const headers = renderConfig(manifest({ "x-task-type": "code", "X-Privacy-Tier": "cloud-ok", "x-privacy-tier": "" }))
      .provider.synapse.options.headers
    expect(headers).toEqual({ "x-task-type": "code", "x-privacy-tier": "local-only" })
  })

  test("only the synapse provider is enabled, with the manifest's model", () => {
    const config = renderConfig(manifest())
    expect(config.enabled_providers).toEqual(["synapse"])
    expect(config.model).toBe("synapse/auto")
    expect(config.small_model).toBe("synapse/auto")
    expect(Object.keys(config.provider)).toEqual(["synapse"])
  })
})
