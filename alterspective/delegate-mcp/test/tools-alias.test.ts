// Tests for automated tool aliasing and server naming (FEAT-CD-001).
import { describe, expect, test } from "bun:test"
import { SERVER_NAME, LEGACY_SERVER_NAME, resolveServerName } from "../src/server.ts"
import { allTools, coreTools, delegateTaskTool } from "../src/tools/index.ts"
import { interactionTools } from "../src/tools/interaction.ts"

describe("Tool aliasing & server naming (FEAT-CD-001)", () => {
  test("server name defaults to code-delegate", () => {
    expect(SERVER_NAME).toBe("code-delegate")
    expect(LEGACY_SERVER_NAME).toBe("opencode-delegate")
    expect(resolveServerName({})).toBe("code-delegate")
  })

  test("server name respects OPENCODE_DELEGATE_SERVER_NAME override", () => {
    expect(resolveServerName({ OPENCODE_DELEGATE_SERVER_NAME: "opencode-delegate" })).toBe("opencode-delegate")
    expect(resolveServerName({ OPENCODE_DELEGATE_SERVER_NAME: "custom-delegate" })).toBe("custom-delegate")
    expect(resolveServerName({}, "requested-name")).toBe("requested-name")
  })

  test("allTools includes delegate_task and code_delegate_task", () => {
    const tools = allTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain("delegate_task")
    expect(names).toContain("code_delegate_task")
    expect(delegateTaskTool.name).toBe("delegate_task")
  })

  test("every oc_* tool has an equivalent code_* alias", () => {
    const tools = allTools()
    const names = new Set(tools.map((t) => t.name))

    const baseTools = [...coreTools, ...interactionTools]
    for (const tool of baseTools) {
      if (tool.name.startsWith("oc_")) {
        const expectedAlias = tool.name.replace(/^oc_/, "code_")
        expect(names.has(expectedAlias)).toBe(true)

        const canonical = tools.find((t) => t.name === tool.name)
        const alias = tools.find((t) => t.name === expectedAlias)
        expect(canonical).toBeDefined()
        expect(alias).toBeDefined()
        expect(alias?.title).toContain(expectedAlias)
        expect(alias?.input).toEqual(canonical?.input)
        expect(alias?.annotations).toEqual(canonical?.annotations)
      }
    }
  })

  test("no duplicate tool names exist in allTools()", () => {
    const tools = allTools()
    const names = new Set<string>()
    for (const tool of tools) {
      expect(names.has(tool.name)).toBe(false)
      names.add(tool.name)
    }
    // Verifies we have at least 40+ total tools (canonical + aliases)
    expect(tools.length).toBeGreaterThanOrEqual(40)
  })
})
