import { describe, expect, test } from "bun:test"
import type { Config, PluginInput } from "@opencode-ai/plugin"
import { DOCS_COMMAND, DOCS_SYSTEM_LINE, DOCS_TEMPLATE, OpencodealtDocsPlugin } from "../../src/plugin/opencodealt-docs"
import { OPENCODEALT_DOCS_URL } from "../../src/installation/opencodealt"

const plugin = () => OpencodealtDocsPlugin({} as PluginInput)

describe("opencodealt docs plugin (#90)", () => {
  test("adds a /docs command that links our guide and keeps the question", async () => {
    const cfg = {} as Config
    await (await plugin()).config?.(cfg)
    const command = cfg.command?.[DOCS_COMMAND]
    expect(command?.template).toBe(DOCS_TEMPLATE)
    expect(DOCS_TEMPLATE).toContain(OPENCODEALT_DOCS_URL)
    expect(DOCS_TEMPLATE).toContain("$ARGUMENTS")
  })

  test("leaves a person's own /docs command alone", async () => {
    const own = { command: { [DOCS_COMMAND]: { template: "mine" } } } as unknown as Config
    await (await plugin()).config?.(own)
    expect(own.command?.[DOCS_COMMAND]?.template).toBe("mine")
  })

  test("tells session turns that opencode.ai/docs is upstream only", async () => {
    const hooks = await plugin()
    const output = { system: ["header"] }
    await hooks["experimental.chat.system.transform"]?.({ sessionID: "ses_1", model: {} as never }, output)
    expect(output.system).toEqual(["header", DOCS_SYSTEM_LINE])
    expect(DOCS_SYSTEM_LINE).toContain("upstream OpenCode only")
    expect(DOCS_SYSTEM_LINE).toContain(OPENCODEALT_DOCS_URL)
  })

  test("adds nothing outside a session", async () => {
    const hooks = await plugin()
    const output = { system: ["generate an agent"] }
    await hooks["experimental.chat.system.transform"]?.({ model: {} as never }, output)
    expect(output.system).toEqual(["generate an agent"])
  })
})
