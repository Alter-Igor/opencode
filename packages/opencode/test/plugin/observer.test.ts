import { describe, expect, test } from "bun:test"
import { sessionObserver } from "../../src/plugin/observer"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

describe("SessionObserverManager.onToolAfter", () => {
  test("records a tool call with string output", async () => {
    const sessionId = "obs-str-1"
    const callId = "call-str-1"
    sessionObserver.onToolBefore(sessionId, callId, "read", { filePath: "/tmp/a.md" })
    sessionObserver.onToolAfter(sessionId, callId, "read", "file contents here")

    const retro = await sessionObserver.finalizeSessionRetrospective(sessionId)
    if (!retro) throw new Error("no retrospective found")
    expect(retro.totalToolCalls).toBe(1)
    expect(retro.toolsUsed).toEqual(["read"])
  })

  test("flags MCP tool failures in the retrospective", async () => {
    const sessionId = "obs-err-1"
    const callId = "call-err-1"
    sessionObserver.onToolBefore(sessionId, callId, "mcp__keystone__execute-tool", {})
    sessionObserver.onToolAfter(sessionId, callId, "mcp__keystone__execute-tool", "Error: Unauthorized")

    const retro = await sessionObserver.finalizeSessionRetrospective(sessionId)
    expect(retro).not.toBeNull()
    const anomaly = retro!.anomalies.find((a) => a.type === "MCP_TOOL_FAILURE")
    expect(anomaly?.tool).toBe("mcp__keystone__execute-tool")
  })

  test("handles non-string output (CallToolResult from MCP catalog)", async () => {
    const sessionId = "obs-mcp-1"
    const callId = "call-mcp-1"
    // Simulates the raw CallToolResult shape returned by convertTool in src/mcp/catalog.ts
    const mcpResult = {
      content: [{ type: "text", text: "some data" }],
      structuredContent: { foo: "bar" },
      meta: {},
    }

    sessionObserver.onToolBefore(sessionId, callId, "imprint_imprint_get_instructions", {})
    // This used to throw: undefined is not an object (evaluating 'output.includes')
    expect(() => {
      sessionObserver.onToolAfter(sessionId, callId, "imprint_imprint_get_instructions", mcpResult)
    }).not.toThrow()
  })

  test("handles null and undefined output gracefully", () => {
    const sessionId = "obs-null-1"
    sessionObserver.onToolBefore(sessionId, "call-null-1", "some-tool", {})
    expect(() => {
      sessionObserver.onToolAfter(sessionId, "call-null-1", "some-tool", null)
    }).not.toThrow()

    sessionObserver.onToolBefore(sessionId, "call-undef-1", "some-tool", {})
    expect(() => {
      sessionObserver.onToolAfter(sessionId, "call-undef-1", "some-tool", undefined)
    }).not.toThrow()
  })

  test("finalizes without crashing when mixed string and object outputs are recorded", async () => {
    const sessionId = "obs-mixed-1"

    sessionObserver.onToolBefore(sessionId, "call-a", "read", {})
    sessionObserver.onToolAfter(sessionId, "call-a", "read", "success")

    sessionObserver.onToolBefore(sessionId, "call-b", "rag_ask", {})
    sessionObserver.onToolAfter(sessionId, "call-b", "rag_ask", { answer: "ok", sources: [] })

    sessionObserver.onToolBefore(sessionId, "call-c", "bash", {})
    sessionObserver.onToolAfter(sessionId, "call-c", "bash", "")

    const retro = await sessionObserver.finalizeSessionRetrospective(sessionId)
    expect(retro).not.toBeNull()
    expect(retro!.totalToolCalls).toBe(3)
  })
})


describe("rule visibility", () => {
  test("lists persisted rules with origin + injected flag, and forgets by text", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-rules-"))
    const prev = process.env.USERPROFILE
    process.env.USERPROFILE = dir
    try {
      const file = path.join(dir, ".local", "share", "opencode", "learnings.json")
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(
        file,
        JSON.stringify([
          { id: "1", timestamp: "2026-09-23T00:00:00.000Z", lesson: "always greet in French", source: "user_feedback" },
          { id: "2", timestamp: "2026-09-22T00:00:00.000Z", lesson: "run typecheck before finishing", source: "user_feedback" },
        ]),
        "utf8",
      )

      const rules = await sessionObserver.listLearnings()
      expect(rules.length).toBe(2)
      expect(rules[0].lesson).toBe("always greet in French")
      expect(rules[0].origin).toBe("central")
      expect(rules[0].injected).toBe(true)
      expect(rules[1].injected).toBe(true)

      const removed = await sessionObserver.forgetLearning("french")
      expect(removed).toBe(1)
      const after = await sessionObserver.listLearnings()
      expect(after.map((r) => r.lesson)).toEqual(["run typecheck before finishing"])

      const noMatch = await sessionObserver.forgetLearning("french")
      expect(noMatch).toBe(0)
    } finally {
      process.env.USERPROFILE = prev
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
