import { describe, expect, test, beforeAll, afterEach } from "bun:test"
import plugin from "../../../../../.opencode/plugin/alterspective-rag-standards"

const mockInput = {} as any

const originalEnabled = process.env.ALTERSPECTIVE_STANDARDS_INJECTION_ENABLED
const originalDisabled = process.env.ALTERSPECTIVE_STANDARDS_INJECTION_DISABLED

describe("alterspective-rag-standards", () => {
  let hooks: any

  beforeAll(async () => {
    delete process.env.ALTERSPECTIVE_STANDARDS_INJECTION_ENABLED
    delete process.env.ALTERSPECTIVE_STANDARDS_INJECTION_DISABLED
    hooks = await plugin(mockInput)
  })

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.ALTERSPECTIVE_STANDARDS_INJECTION_ENABLED
    else process.env.ALTERSPECTIVE_STANDARDS_INJECTION_ENABLED = originalEnabled
    if (originalDisabled === undefined) delete process.env.ALTERSPECTIVE_STANDARDS_INJECTION_DISABLED
    else process.env.ALTERSPECTIVE_STANDARDS_INJECTION_DISABLED = originalDisabled
  })

  test("returns hooks with experimental.chat.system.transform", () => {
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function")
  })

  test("hook appends a string to output.system", async () => {
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]({ model: {} as any }, output)
    expect(output.system.length).toBe(1)
    expect(typeof output.system[0]).toBe("string")
  })

  test("added string contains Alterspective Standards Awareness heading", async () => {
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]({ model: {} as any }, output)
    expect(output.system[0]).toContain("Alterspective Standards Awareness")
  })

  test("added string mentions rag_search or rag_ask", async () => {
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]({ model: {} as any }, output)
    expect(output.system[0].includes("rag_search") || output.system[0].includes("rag_ask")).toBe(true)
  })

  test("when RAG fails, the local knowledge checkout is the allowed copy", async () => {
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]({ model: {} as any }, output)
    expect(output.system[0]).toContain("C:\\GitHub\\Alterspective-Intelligence")
    expect(output.system[0]).toContain("Do not invent the rule")
  })

  test("does NOT inject when ALTERSPECTIVE_STANDARDS_INJECTION_DISABLED=true", async () => {
    process.env.ALTERSPECTIVE_STANDARDS_INJECTION_DISABLED = "true"
    const localHooks: any = await plugin(mockInput)
    const output = { system: [] as string[] }
    await localHooks["experimental.chat.system.transform"]({ model: {} as any }, output)
    expect(output.system.length).toBe(0)
  })

  test("removes the local skill catalogue and tells the model to use RAG", async () => {
    const output = {
      system: [
        [
          "Instructions from: C:/GitHub/opencode/AGENTS.md",
          "keep this",
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          "<available_skills>",
          "  <skill>",
          "    <name>commit-pr</name>",
          "    <description>A long local skill that must not stay in the prompt.</description>",
          "    <location>C:/Users/someone/.agents/skills/commit-pr/SKILL.md</location>",
          "  </skill>",
          "</available_skills>",
        ].join("\n"),
      ],
    }
    await hooks["experimental.chat.system.transform"]({ model: {} as any }, output)
    const joined = output.system.join("\n")
    expect(joined).not.toContain("<available_skills>")
    expect(joined).not.toContain("commit-pr")
    expect(joined).toContain("keep this")
    expect(joined).toContain("call rag_search for a skill")
    expect(joined).toContain("customize-opencode")
    expect(joined).toContain("Alterspective Standards Awareness")
  })

  test("does NOT inject when ALTERSPECTIVE_STANDARDS_INJECTION_ENABLED=false", async () => {
    process.env.ALTERSPECTIVE_STANDARDS_INJECTION_ENABLED = "false"
    const localHooks: any = await plugin(mockInput)
    const output = { system: [] as string[] }
    await localHooks["experimental.chat.system.transform"]({ model: {} as any }, output)
    expect(output.system.length).toBe(0)
  })
})
