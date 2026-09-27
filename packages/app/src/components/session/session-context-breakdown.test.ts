import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { contextUsageFromParts, estimateSessionContextBreakdown, presentContextUsage } from "./session-context-breakdown"

const user = (id: string) => {
  return {
    id,
    role: "user",
    time: { created: 1 },
  } as unknown as Message
}

const assistant = (id: string) => {
  return {
    id,
    role: "assistant",
    time: { created: 1 },
  } as unknown as Message
}

describe("estimateSessionContextBreakdown", () => {
  test("estimates tokens and keeps remaining tokens as other", () => {
    const messages = [user("u1"), assistant("a1")]
    const parts = {
      u1: [{ type: "text", text: "hello world" }] as unknown as Part[],
      a1: [{ type: "text", text: "assistant response" }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 20,
      systemPrompt: "system prompt",
    })

    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))
    expect(map.system).toBe(4)
    expect(map.user).toBe(3)
    expect(map.assistant).toBe(5)
    expect(map.other).toBe(8)
  })

  test("uses the last saved measurement", () => {
    const rows = contextUsageFromParts([
      { type: "text", synthetic: true, metadata: { contextUsage: [{ label: "Instructions", tokens: 1 }] } },
      { type: "text", text: "answer" },
      { type: "text", synthetic: true, metadata: { contextUsage: [{ label: "Instructions", tokens: 9 }] } },
    ])
    expect(rows).toEqual([{ label: "Instructions", tokens: 9 }])
  })

  test("adds the provider remainder as left over", () => {
    const rows = presentContextUsage(
      [
        { label: "Instructions", tokens: 17000 },
        { label: "RAG tools", tokens: 8000 },
      ],
      30000,
    )
    const map = Object.fromEntries(rows.map((row) => [row.label, row.tokens]))
    expect(map.Instructions).toBe(17000)
    expect(map["RAG tools"]).toBe(8000)
    expect(map["Left over"]).toBe(5000)
    expect(rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(30000)
  })

  test("scales segments when estimates exceed input", () => {
    const messages = [user("u1"), assistant("a1")]
    const parts = {
      u1: [{ type: "text", text: "x".repeat(400) }] as unknown as Part[],
      a1: [{ type: "text", text: "y".repeat(400) }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 10,
      systemPrompt: "z".repeat(200),
    })

    const total = output.reduce((sum, segment) => sum + segment.tokens, 0)
    expect(total).toBeLessThanOrEqual(10)
    expect(output.every((segment) => segment.width <= 100)).toBeTrue()
  })
})
