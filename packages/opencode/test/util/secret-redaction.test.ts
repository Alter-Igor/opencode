// #26, #205, #207: secret redaction helpers, placeholder write/edit guards, and shell preview boundary redaction.
// Fixtures are assembled at run time so no literal key-shaped string sits in the source file.
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import {
  introducesRedactedPlaceholder,
  redactedCopy,
  redactedDurableEventData,
  redactedToolPart,
  redactSecrets,
  redactSecretsInText,
  redactSecretsInValue,
  redactToolPart,
  redactToolResult,
} from "../../../core/src/util/secret-redaction"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { preview } from "../../src/tool/shell"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const fake = (prefix: string, body: string, length: number) =>
  prefix + body.repeat(Math.ceil(length / body.length)).slice(0, length)

const KEYS: Record<string, string> = {
  openrouter: fake("sk-" + "or-v1-", "5a5f0c", 64),
  anthropic: fake("sk-" + "ant-api03-", "Ab9_", 90),
  openai: fake("sk-" + "proj-", "Q7xZ", 48),
  github: fake("gh" + "p_", "aB3dE", 36),
  synapse: fake("gp" + "app_", "k9Zr", 32),
}

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test-redaction-guard"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
    ]),
  ),
)

const runWrite = Effect.fn("RedactionGuardTest.runWrite")(function* (
  args: Tool.InferParameters<typeof WriteTool>,
) {
  const info = yield* WriteTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

const failWrite = Effect.fn("RedactionGuardTest.failWrite")(function* (
  args: Tool.InferParameters<typeof WriteTool>,
) {
  const exit = yield* runWrite(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected write to fail")
})

const runEdit = Effect.fn("RedactionGuardTest.runEdit")(function* (
  args: Tool.InferParameters<typeof EditTool>,
) {
  const info = yield* EditTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

const failEdit = Effect.fn("RedactionGuardTest.failEdit")(function* (
  args: Tool.InferParameters<typeof EditTool>,
) {
  const exit = yield* runEdit(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

describe("introducesRedactedPlaceholder (#205)", () => {
  test("detects newly introduced [REDACTED:<kind>] placeholders", () => {
    expect(introducesRedactedPlaceholder("API_KEY=[REDACTED:openai]\n")).toBe("[REDACTED:openai]")
    expect(introducesRedactedPlaceholder("API_KEY=[REDACTED:openrouter]\n", `API_KEY=${KEYS.openrouter}\n`)).toBe(
      "[REDACTED:openrouter]",
    )
    expect(introducesRedactedPlaceholder("TOKEN=[REDACTED:url-credentials]\n", "")).toBe(
      "[REDACTED:url-credentials]",
    )
  })

  test("allows unchanged or fewer existing [REDACTED:<kind>] placeholders", () => {
    const existing = "example: [REDACTED:openai] and [REDACTED:github]\n"
    expect(introducesRedactedPlaceholder(existing, existing)).toBeUndefined()
    expect(introducesRedactedPlaceholder("updated header\n" + existing, existing)).toBeUndefined()
    expect(introducesRedactedPlaceholder("example: [REDACTED:openai]\n", existing)).toBeUndefined()
    expect(introducesRedactedPlaceholder("plain text without placeholders", "previous plain text")).toBeUndefined()
  })

  test("detects when the count of an existing placeholder kind increases", () => {
    const previous = "FIRST=[REDACTED:openai]\nSECOND=real_value\n"
    const next = "FIRST=[REDACTED:openai]\nSECOND=[REDACTED:openai]\n"
    expect(introducesRedactedPlaceholder(next, previous)).toBe("[REDACTED:openai]")
  })
})

describe("write and edit placeholder guards (#205)", () => {
  it.instance("write refuses to overwrite a real key with a [REDACTED:<kind>] placeholder", () =>
    Effect.gen(function* () {
      const inst = yield* TestInstance
      const filepath = path.join(inst.directory, ".env")
      const original = `OPENROUTER_API_KEY=${KEYS.openrouter}\nPORT=3000\n`
      yield* Effect.promise(() => fs.writeFile(filepath, original, "utf-8"))

      const err = yield* failWrite({
        filePath: filepath,
        content: "OPENROUTER_API_KEY=[REDACTED:openrouter]\nPORT=4000\n",
      })
      expect(err.message).toContain("Refusing to write redacted placeholder [REDACTED:openrouter]")
      expect(err.message).toContain(filepath)

      const onDisk = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(onDisk).toBe(original)
    }),
  )

  it.instance("write refuses to create a new file containing a [REDACTED:<kind>] placeholder", () =>
    Effect.gen(function* () {
      const inst = yield* TestInstance
      const filepath = path.join(inst.directory, "new.env")

      const err = yield* failWrite({
        filePath: filepath,
        content: "OPENAI_API_KEY=[REDACTED:openai]\n",
      })
      expect(err.message).toContain("Refusing to write redacted placeholder [REDACTED:openai]")
    }),
  )

  it.instance("write allows updating a file that already contained the same [REDACTED:<kind>] placeholder", () =>
    Effect.gen(function* () {
      const inst = yield* TestInstance
      const filepath = path.join(inst.directory, "fixture.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, "doc: [REDACTED:openai]\nversion: 1\n", "utf-8"))

      yield* runWrite({
        filePath: filepath,
        content: "doc: [REDACTED:openai]\nversion: 2\n",
      })

      const onDisk = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(onDisk).toBe("doc: [REDACTED:openai]\nversion: 2\n")
    }),
  )

  it.instance("edit refuses to replace a real value with a [REDACTED:<kind>] placeholder", () =>
    Effect.gen(function* () {
      const inst = yield* TestInstance
      const filepath = path.join(inst.directory, "config.env")
      const original = `SYNAPSE_KEY=${KEYS.synapse}\nMODE=dev\n`
      yield* Effect.promise(() => fs.writeFile(filepath, original, "utf-8"))

      const err = yield* failEdit({
        filePath: filepath,
        oldString: `SYNAPSE_KEY=${KEYS.synapse}\nMODE=dev`,
        newString: "SYNAPSE_KEY=[REDACTED:synapse]\nMODE=prod",
      })
      expect(err.message).toContain("Refusing to write redacted placeholder [REDACTED:synapse]")
      expect(err.message).toContain(filepath)

      const onDisk = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(onDisk).toBe(original)
    }),
  )

  it.instance("edit refuses anchor-matched block edits that would overwrite a real key on disk with [REDACTED:<kind>]", () =>
    Effect.gen(function* () {
      const inst = yield* TestInstance
      const filepath = path.join(inst.directory, "anchored.env")
      const original = ["HEADER=1", "MIDDLE=keep", `SECRET=${KEYS.openai}`, "FOOTER=1"].join("\n")
      yield* Effect.promise(() => fs.writeFile(filepath, original, "utf-8"))

      const err = yield* failEdit({
        filePath: filepath,
        oldString: ["HEADER=1", "MIDDLE=keep", "SECRET=[REDACTED:openai]", "FOOTER=1"].join("\n"),
        newString: ["HEADER=1", "MIDDLE=changed", "SECRET=[REDACTED:openai]", "FOOTER=1"].join("\n"),
      })
      expect(err.message).toContain("Refusing to write redacted placeholder [REDACTED:openai]")

      const onDisk = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(onDisk).toBe(original)
    }),
  )

  it.instance("edit allows modifying a file that already legitimately contains [REDACTED:<kind>]", () =>
    Effect.gen(function* () {
      const inst = yield* TestInstance
      const filepath = path.join(inst.directory, "readme.md")
      yield* Effect.promise(() =>
        fs.writeFile(filepath, "Line 1: [REDACTED:github]\nLine 2: old\n", "utf-8"),
      )

      yield* runEdit({
        filePath: filepath,
        oldString: "Line 1: [REDACTED:github]\nLine 2: old",
        newString: "Line 1: [REDACTED:github]\nLine 2: new",
      })

      const onDisk = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(onDisk).toBe("Line 1: [REDACTED:github]\nLine 2: new\n")
    }),
  )
})

describe("shell preview boundary redaction (#207)", () => {
  test("redacts a secret straddling the 30,000-character preview window boundary before slicing", () => {
    const key = KEYS.openrouter
    const prefix = "a".repeat(500) + "\n"
    const suffix = "\n" + "b".repeat(30_000 - 20)
    const raw = prefix + key + suffix
    const out = preview(raw)

    expect(out).not.toContain(key)
    expect(out).not.toContain(key.slice(-20))
    expect(out).toStartWith("...\n\n")
  })

  test("redactSecretsInText and redactSecretsInValue scrub strings and nested objects", () => {
    expect(redactSecretsInText(`token: ${KEYS.github}`)).toBe("token: [REDACTED:github]")
    const payload = { nested: { key: KEYS.anthropic, ok: "plain" } }
    redactSecretsInValue(payload)
    expect(payload.nested.key).toBe("[REDACTED:anthropic]")
    expect(payload.nested.ok).toBe("plain")
    expect(redactSecrets(KEYS.openai)).toBe("[REDACTED:openai]")
    expect(redactedCopy({ k: KEYS.synapse }).k).toBe("[REDACTED:synapse]")
    expect(redactToolResult({ output: KEYS.github })).toBe(1)
    expect(redactToolPart({ type: "tool", state: { output: KEYS.github } })).toBe(1)
    expect(redactedToolPart({ type: "tool", state: { output: KEYS.github } }).state.output).toBe("[REDACTED:github]")
    expect(
      redactedDurableEventData("session.part.updated", {
        part: { type: "tool", state: { output: KEYS.openrouter } },
      }).part.state.output,
    ).toBe("[REDACTED:openrouter]")
  })
})
