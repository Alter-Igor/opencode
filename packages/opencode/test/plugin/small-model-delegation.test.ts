import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin"

type Model = Parameters<NonNullable<Hooks["experimental.chat.system.transform"]>>[0]["model"]
import {
  DEFAULT_SMALL_MODEL_CONTEXT_THRESHOLD,
  SmallModelDelegationPlugin,
  parseThreshold,
  smallModelDelegationPrompt,
} from "../../src/plugin/small-model-delegation"

const createPlugin = () => SmallModelDelegationPlugin({} as PluginInput)

describe("small model delegation plugin", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env["OPENCODE_SMALL_MODEL_THRESHOLD"]
    delete process.env["OPENCODE_SMALL_MODEL_DELEGATION"]
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test("parses threshold with fallback to default", () => {
    expect(parseThreshold(undefined, undefined)).toBe(DEFAULT_SMALL_MODEL_CONTEXT_THRESHOLD)
    expect(parseThreshold("16384", undefined)).toBe(16384)
    expect(parseThreshold(undefined, 8192)).toBe(8192)
    expect(parseThreshold("65536", 8192)).toBe(65536)
  })

  test("injects delegation prompt when model context <= default threshold (32768)", async () => {
    const hooks = await createPlugin()
    const output = { system: ["base prompt"] }
    const model = {
      limit: { context: 16384 },
    } as unknown as Model

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_main", model, agent: "build" },
      output,
    )

    expect(output.system.length).toBe(2)
    expect(output.system[1]).toBe(smallModelDelegationPrompt(16384))
    expect(output.system[1]).toContain("subagent_type: 'explore'")
  })

  test("does not inject prompt when model context exceeds threshold", async () => {
    const hooks = await createPlugin()
    const output = { system: ["base prompt"] }
    const model = {
      limit: { context: 128000 },
    } as unknown as Model

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_main", model, agent: "build" },
      output,
    )

    expect(output.system).toEqual(["base prompt"])
  })

  test("does not inject prompt outside a session", async () => {
    const hooks = await createPlugin()
    const output = { system: ["base prompt"] }
    const model = {
      limit: { context: 8192 },
    } as unknown as Model

    await hooks["experimental.chat.system.transform"]?.(
      { model, agent: "build" },
      output,
    )

    expect(output.system).toEqual(["base prompt"])
  })

  test("does not inject prompt when inside a subagent session (parentSessionID set)", async () => {
    const hooks = await createPlugin()
    const output = { system: ["base prompt"] }
    const model = {
      limit: { context: 8192 },
    } as unknown as Model

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_sub", parentSessionID: "ses_main", model, agent: "build" },
      output,
    )

    expect(output.system).toEqual(["base prompt"])
  })

  test("does not inject prompt for non-build subagents like explore", async () => {
    const hooks = await createPlugin()
    const output = { system: ["base prompt"] }
    const model = {
      limit: { context: 8192 },
    } as unknown as Model

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_main", model, agent: "explore" },
      output,
    )

    expect(output.system).toEqual(["base prompt"])
  })

  test("respects OPENCODE_SMALL_MODEL_THRESHOLD env override", async () => {
    process.env["OPENCODE_SMALL_MODEL_THRESHOLD"] = "8192"
    const hooks = await createPlugin()
    const output = { system: ["base prompt"] }
    const model = {
      limit: { context: 16384 },
    } as unknown as Model

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_main", model, agent: "build" },
      output,
    )

    // 16384 > 8192 threshold, so it should not trigger
    expect(output.system).toEqual(["base prompt"])
  })

  test("respects OPENCODE_SMALL_MODEL_DELEGATION=0 to disable", async () => {
    process.env["OPENCODE_SMALL_MODEL_DELEGATION"] = "0"
    const hooks = await createPlugin()
    const output = { system: ["base prompt"] }
    const model = {
      limit: { context: 8192 },
    } as unknown as Model

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_main", model, agent: "build" },
      output,
    )

    expect(output.system).toEqual(["base prompt"])
  })

  test("respects OPENCODE_SMALL_MODEL_DELEGATION=1 to force enable even with large context", async () => {
    process.env["OPENCODE_SMALL_MODEL_DELEGATION"] = "1"
    const hooks = await createPlugin()
    const output = { system: ["base prompt"] }
    const model = {
      limit: { context: 200000 },
    } as unknown as Model

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_main", model, agent: "build" },
      output,
    )

    expect(output.system.length).toBe(2)
    expect(output.system[1]).toContain("CRITICAL CONTEXT LIMIT")
  })

  test("respects experimental.small_model_threshold in config", async () => {
    const hooks = await createPlugin()
    const cfg = {
      experimental: {
        small_model_threshold: 65536,
      },
    } as unknown as Config
    await hooks.config?.(cfg)

    const output = { system: ["base prompt"] }
    const model = {
      limit: { context: 49152 },
    } as unknown as Model

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_main", model, agent: "build" },
      output,
    )

    expect(output.system.length).toBe(2)
    expect(output.system[1]).toContain("49152 tokens")
  })

  test("tool guard blocks direct grep and read in small model main session", async () => {
    const hooks = await createPlugin()
    const output = { system: ["base prompt"] }
    const model = {
      limit: { context: 16384 },
    } as unknown as Model

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_small", model, agent: "build" },
      output,
    )

    // grep should be blocked
    expect(
      hooks["tool.execute.before"]?.(
        { tool: "grep", sessionID: "ses_small", callID: "call_1" },
        { args: { pattern: "test" } },
      ),
    ).rejects.toThrow("Context limit protection: Direct \"grep\" is restricted")

    // read should be blocked
    expect(
      hooks["tool.execute.before"]?.(
        { tool: "read", sessionID: "ses_small", callID: "call_2" },
        { args: { file: "test.ts" } },
      ),
    ).rejects.toThrow("Context limit protection: Direct \"read\" is restricted")

    // task should be allowed
    expect(
      hooks["tool.execute.before"]?.(
        { tool: "task", sessionID: "ses_small", callID: "call_3" },
        { args: { subagent_type: "explore" } },
      ),
    ).resolves.toBeUndefined()
  })

  test("tool guard allows grep and read for large models and subagents", async () => {
    const hooks = await createPlugin()
    const output = { system: ["base prompt"] }
    const largeModel = {
      limit: { context: 128000 },
    } as unknown as Model

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_large", model: largeModel, agent: "build" },
      output,
    )

    // Large model session should allow grep
    expect(
      hooks["tool.execute.before"]?.(
        { tool: "grep", sessionID: "ses_large", callID: "call_1" },
        { args: {} },
      ),
    ).resolves.toBeUndefined()

    // Subagent session should allow grep
    expect(
      hooks["tool.execute.before"]?.(
        { tool: "grep", sessionID: "ses_child", callID: "call_2" },
        { args: {} },
      ),
    ).resolves.toBeUndefined()
  })
})
