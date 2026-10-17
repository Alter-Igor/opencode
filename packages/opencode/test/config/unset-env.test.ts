// Fork (#24): config loading names the {env:VAR} references the process cannot resolve.
import { describe, expect, test } from "bun:test"
import { unsetEnvReferences } from "../../src/config/unset-env"

describe("unsetEnvReferences (#24)", () => {
  const SET = "OPENCODE_TEST_UNSET_ENV_SET"
  const MISSING = "OPENCODE_TEST_UNSET_ENV_MISSING"

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

  test("text with no references returns nothing", () => {
    expect(unsetEnvReferences(`{"model": "synapse/auto"}`)).toEqual([])
  })

  test("config loading checks the text before it substitutes it", async () => {
    const source = await Bun.file(new URL("../../src/config/config.ts", import.meta.url)).text()
    const check = source.indexOf("ConfigUnsetEnv.unsetEnvReferences(text, env)")
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(source.indexOf("ConfigVariable.substitute(", check))
  })
})
