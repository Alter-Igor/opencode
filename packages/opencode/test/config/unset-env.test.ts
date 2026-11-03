// Fork (#24): config loading names the {env:VAR} references the process cannot resolve.
import { describe, expect, test } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer, Logger } from "effect"
import { HttpClient } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { stripJsonComments, unsetEnvReferences } from "../../src/config/unset-env"
import { Env } from "../../src/env"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { tmpdirScoped } from "../fixture/fixture"

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const configLayer = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
  [Auth.node, AuthTest.empty],
  [Account.node, AccountTest.empty],
  [Npm.node, NpmTest.noop],
  [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
])

describe("unsetEnvReferences (#24)", () => {
  const SET = "OPENCODE_TEST_UNSET_ENV_SET"
  const MISSING = "OPENCODE_TEST_UNSET_ENV_MISSING"
  const MISSING_COMMENT = "OPENCODE_TEST_UNSET_ENV_COMMENT"

  test("names each unset variable once, and not a set one", () => {
    process.env[SET] = "value"
    delete process.env[MISSING]
    try {
      const text = `{"a": "{env:${MISSING}}", "b": "{env:${SET}}", "c": "x {env:${MISSING}} y"}`
      expect(unsetEnvReferences(text)).toEqual([MISSING])
    } finally {
      delete process.env[SET]
    }
  })

  test("reads the env override first, like ConfigVariable.substitute", () => {
    delete process.env[MISSING]
    expect(unsetEnvReferences(`"{env:${MISSING}}"`, { [MISSING]: "from override" })).toEqual([])
    process.env[MISSING] = "from process"
    try {
      // An empty override wins over the process value (substitute uses `??`), so it resolves to "".
      expect(unsetEnvReferences(`"{env:${MISSING}}"`, { [MISSING]: "" })).toEqual([MISSING])
      expect(unsetEnvReferences(`"{env:${MISSING}}"`)).toEqual([])
    } finally {
      delete process.env[MISSING]
    }
  })

  test("an empty value counts as unset, and a reference on a // comment line does not count", () => {
    process.env[SET] = ""
    delete process.env[MISSING]
    try {
      const text = `{\n  // "old": "{env:${MISSING}}",\n  "key": "{env:${SET}}"\n}`
      expect(unsetEnvReferences(text)).toEqual([SET])
    } finally {
      delete process.env[SET]
    }
  })

  test("ignores inline // trailing comments, CR-only line endings, and /* ... */ block comments outside strings", () => {
    delete process.env[MISSING]
    delete process.env[MISSING_COMMENT]
    const text = [
      "{",
      `  "active": "{env:${MISSING}}", // inline trailing comment "{env:${MISSING_COMMENT}}"`,
      `  /* single-line block comment {env:${MISSING_COMMENT}} */`,
      "  /*",
      `   * multi-line block comment {env:${MISSING_COMMENT}}`,
      "   */",
      '  "model": "synapse/auto"',
      "}",
    ].join("\n")
    expect(unsetEnvReferences(text)).toEqual([MISSING])

    const crOnly = `{\r  // commented "{env:${MISSING_COMMENT}}"\r  "active": "{env:${MISSING}}"\r}`
    expect(unsetEnvReferences(crOnly)).toEqual([MISSING])
  })

  test("preserves URLs and comment-like tokens inside string literals including escaped quotes", () => {
    delete process.env[MISSING]
    delete process.env[MISSING_COMMENT]
    const text = JSON.stringify({
      url: `https://example.com/*not-a-comment*/{env:${MISSING}}`,
      note: 'quote \\" // still in string \\" /* also in string */',
    })
    expect(stripJsonComments(text)).toBe(text)
    expect(unsetEnvReferences(`${text} // {env:${MISSING_COMMENT}}`)).toEqual([MISSING])
  })

  test("text with no references returns nothing", () => {
    expect(unsetEnvReferences(`{"model": "synapse/auto"}`)).toEqual([])
  })

  test("config loading checks the text before it substitutes it", async () => {
    const source = await Bun.file(new URL("../../src/config/config.ts", import.meta.url)).text()
    const check = source.indexOf("ConfigUnsetEnv.unsetEnvReferences(text, env)")
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(source.indexOf("ConfigVariable.substitute(", check))
  })

  test("loader logs unset env warning with variable names only (including before invalid JSON/schema fails)", async () => {
    process.env[SET] = "super-secret-value"
    delete process.env[MISSING]
    delete process.env[MISSING_COMMENT]
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const dir = yield* tmpdirScoped()
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = dir
          try {
            const configPath = path.join(dir, "opencode.jsonc")
            yield* FSUtil.use.writeWithDirs(
              configPath,
              [
                "{",
                '  "$schema": "https://opencode.ai/config.json",',
                `  // commented "{env:${MISSING_COMMENT}}"`,
                `  "username": "{env:${MISSING}}", /* block "{env:${MISSING_COMMENT}}" */`,
                `  "instructions": ["{env:${SET}}"]`,
                "}",
              ].join("\n"),
            )
            yield* Config.use.invalidate()

            const messages: unknown[] = []
            const logger = Logger.layer([
              Logger.make<unknown, void>((options) => {
                messages.push(options.message)
              }),
            ])

            yield* Config.use.getGlobal().pipe(Effect.provide(logger))

            const serialized = JSON.stringify(messages)
            expect(serialized).not.toContain("super-secret-value")
            expect(serialized).not.toContain(MISSING_COMMENT)
            expect(
              messages.filter(
                (item) =>
                  Array.isArray(item) &&
                  item[0] === "config references environment variables this process does not have; they resolve to empty",
              ),
            ).toEqual([
              [
                "config references environment variables this process does not have; they resolve to empty",
                expect.objectContaining({
                  path: configPath,
                  variables: [MISSING],
                }),
              ],
            ])

            // Verify invalid JSON/schema still logs the unset-env warning before ConfigParse rejects the file.
            yield* FSUtil.use.writeWithDirs(configPath, `{ "username": "{env:${MISSING}}", invalid jsonc`)
            yield* Config.use.invalidate()
            const errorMessages: unknown[] = []
            const errorLogger = Logger.layer([
              Logger.make<unknown, void>((options) => {
                errorMessages.push(options.message)
              }),
            ])
            const invalidExit = yield* Config.use.getGlobal().pipe(Effect.provide(errorLogger), Effect.exit)
            expect(Exit.isFailure(invalidExit)).toBe(true)
            expect(
              Exit.isFailure(invalidExit) ? (Cause.squash(invalidExit.cause) as { name?: string })?.name : undefined,
            ).toBe("ConfigJsonError")
            expect(
              errorMessages.some(
                (item) =>
                  Array.isArray(item) &&
                  item[0] === "config references environment variables this process does not have; they resolve to empty",
              ),
            ).toBe(true)
          } finally {
            ;(Global.Path as { config: string }).config = previous
            yield* Config.use.invalidate()
          }
        }).pipe(Effect.scoped, Effect.provide(configLayer)),
      )
    } finally {
      delete process.env[SET]
    }
  })
})
