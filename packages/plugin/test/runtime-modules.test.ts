import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { discoverPluginRuntimeSpecifiers, pluginRuntimeLoaderCode } from "../src/runtime-modules.js"

describe("pluginRuntimeLoaderCode", () => {
  it("rewrites @opencode-ai/plugin compatibility specifiers to @opencode/plugin for bundling", () => {
    const entries = discoverPluginRuntimeSpecifiers()
    assert.equal(pluginRuntimeLoaderCode("@opencode-ai/plugin", entries), '() => require("@opencode/plugin")')
    assert.equal(
      pluginRuntimeLoaderCode("@opencode-ai/plugin/effect/tool", entries),
      '() => require("@opencode/plugin/effect/tool")',
    )
    assert.equal(
      pluginRuntimeLoaderCode("@opencode/plugin/effect/tool", entries),
      '() => require("@opencode/plugin/effect/tool")',
    )
  })
})
