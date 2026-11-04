// Fork (#24): config loading names the {env:VAR} references the process cannot resolve.
import { describe, expect, test } from "bun:test"
import { ConfigVariable } from "../../src/config/variable"
import { stripJsonComments, unsetEnvReferences } from "../../src/config/unset-env"

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

  test("warnUnsetConfigEnvVars logs unset env warning with variable names only", () => {
    process.env[SET] = "super-secret-value"
    delete process.env[MISSING]
    delete process.env[MISSING_COMMENT]
    try {
      const messages: unknown[] = []
      const configPath = "/tmp/opencode.jsonc"
      const text = [
        "{",
        '  "$schema": "https://opencode.ai/config.json",',
        `  // commented "{env:${MISSING_COMMENT}}"`,
        `  "username": "{env:${MISSING}}", /* block "{env:${MISSING_COMMENT}}" */`,
        `  "instructions": ["{env:${SET}}"]`,
        "}",
      ].join("\n")

      const unset = ConfigVariable.warnUnsetConfigEnvVars(text, configPath, (msg, extra) => {
        messages.push([msg, extra])
      })
      expect(unset).toEqual([MISSING])
      const serialized = JSON.stringify(messages)
      expect(serialized).not.toContain("super-secret-value")
      expect(serialized).not.toContain(MISSING_COMMENT)
      expect(serialized).toContain(MISSING)
    } finally {
      delete process.env[SET]
    }
  })
})
