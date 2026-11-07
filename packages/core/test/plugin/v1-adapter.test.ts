import { expect, describe } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Tool } from "@opencode/core/tool"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Exit } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"
import { fromLegacyV1Plugin } from "../../src/plugin/v1-adapter"

const it = testEffect(PluginTestLayer)

const execute = (snapshot: Tool.Snapshot, name: string) =>
  snapshot
    .execute({
      sessionID: Session.ID.make("ses_v1_adapter"),
      agent: Agent.ID.make("build"),
      messageID: SessionMessage.ID.make("msg_v1_adapter"),
      call: { type: "tool-call", id: `call_${name}`, name, input: {} },
    })
    .pipe(Effect.exit)

describe("v1-adapter tool result (#297)", () => {
  it.live("v1 tool returning string succeeds without 'Tool result declared output without an output schema'", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const tools = yield* Tool.Service
      const host = yield* PluginHost.make(plugins, "v1-string")

      const plugin = fromLegacyV1Plugin("v1-string", async () => ({
        tool: {
          "greet-string": {
            description: "returns string",
            args: {},
            execute: async () => "Hello from v1 string tool!",
          },
        },
      }))

      yield* plugin.effect(host)

      const snapshot = yield* tools.snapshot()
      const exit = yield* execute(snapshot, "greet-string")

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.output).toBeUndefined()
        expect(exit.value.content).toEqual([{ type: "text", text: "Hello from v1 string tool!" }])
      }
    }),
  )

  it.live("v1 tool returning object without attachments succeeds and omits output property", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const tools = yield* Tool.Service
      const host = yield* PluginHost.make(plugins, "v1-object")

      const plugin = fromLegacyV1Plugin("v1-object", async () => ({
        tool: {
          "greet-object": {
            description: "returns object",
            args: {},
            execute: async () => ({
              output: "Hello from v1 object tool!",
              title: "Greeting Title",
              metadata: { custom: "val" },
            }),
          },
        },
      }))

      yield* plugin.effect(host)

      const snapshot = yield* tools.snapshot()
      const exit = yield* execute(snapshot, "greet-object")

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.output).toBeUndefined()
        expect(exit.value.content).toEqual([{ type: "text", text: "Hello from v1 object tool!" }])
        // the v1-adapter folds the v1 `title` into metadata
        expect(exit.value.metadata).toEqual({ title: "Greeting Title", custom: "val" })
      }
    }),
  )

  it.live("v1 tool returning object with attachments succeeds and normalizes content", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const tools = yield* Tool.Service
      const host = yield* PluginHost.make(plugins, "v1-attach")

      const plugin = fromLegacyV1Plugin("v1-attach", async () => ({
        tool: {
          "greet-attach": {
            description: "returns attachments",
            args: {},
            execute: async () => ({
              output: "Primary text",
              attachments: [
                {
                  type: "file" as const,
                  url: "file:///path/to/report.pdf",
                  mime: "application/pdf",
                  filename: "report.pdf",
                },
              ],
            }),
          },
        },
      }))

      yield* plugin.effect(host)

      const snapshot = yield* tools.snapshot()
      const exit = yield* execute(snapshot, "greet-attach")

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.output).toBeUndefined()
        expect(exit.value.content).toEqual([
          { type: "text", text: "Primary text" },
          {
            type: "file",
            uri: "file:///path/to/report.pdf",
            mime: "application/pdf",
            name: "report.pdf",
          },
        ])
      }
    }),
  )
})
