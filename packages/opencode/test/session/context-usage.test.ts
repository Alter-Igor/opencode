import { describe, expect, test } from "bun:test"
import { measureContextUsage } from "../../src/session/context-usage"

describe("measureContextUsage", () => {
  test("splits system text and groups tools", () => {
    const rows = measureContextUsage({
      messages: [
        {
          role: "system",
          content: [
            "You are a coding assistant.",
            "Instructions from: C:/GitHub/opencode/AGENTS.md\nKeep changes small.",
            "## Skills\nCall rag_search for a skill.",
            "## Alterspective Standards Awareness\nCite the rule ID.",
          ].join("\n"),
        },
        { role: "user", content: "Reply with PONG" },
      ],
      tools: {
        read: {
          description: "Read a file",
          inputSchema: { jsonSchema: { type: "object", properties: { path: { type: "string" } } } },
        },
        rag_search: {
          description: "Search the knowledge base",
          inputSchema: { jsonSchema: { type: "object", properties: { query: { type: "string" } } } },
        },
        "cas-safe-delegate": { description: "Delegate a run" },
        invalid: { description: "skip me" },
      },
    })
    const map = Object.fromEntries(rows.map((row) => [row.label, row.tokens]))
    expect(map["System text"]).toBeGreaterThan(0)
    expect(map.Instructions).toBeGreaterThan(0)
    expect(map["Skill lookup"]).toBeGreaterThan(0)
    expect(map.Standards).toBeGreaterThan(0)
    expect(map["Your messages"]).toBeGreaterThan(0)
    expect(map["Built-in tools"]).toBeGreaterThan(0)
    expect(map["RAG tools"]).toBeGreaterThan(0)
    expect(map["CAS tools"]).toBeGreaterThan(0)
    expect(map["Earlier replies"]).toBeUndefined()
    expect(map["Tool results"]).toBeUndefined()
    expect(rows.some((row) => row.label === "invalid")).toBe(false)
  })

  test("counts a large tool result on its own row", () => {
    const rows = measureContextUsage({
      messages: [
        { role: "user", content: "read the file" },
        { role: "tool", content: "x".repeat(400) },
      ],
      tools: {},
    })
    const map = Object.fromEntries(rows.map((row) => [row.label, row.tokens]))
    expect(map["Tool results"]).toBe(100)
  })
})