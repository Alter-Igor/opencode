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
  // Declared before any other learning test so the observer's in-memory cache is
  // still empty and the real "read from file" injection path actually runs.
  test("reports the real injection window and counts a rule once across both stores", async () => {
    const central = await fs.mkdtemp(path.join(os.tmpdir(), "oc-central-"))
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "oc-ws-"))
    const prev = process.env.USERPROFILE
    process.env.USERPROFILE = central
    const centralFile = path.join(central, ".local", "share", "opencode", "learnings.json")
    const wsFile = path.join(ws, ".system_generated", "logs", "learnings.json")
    try {
      await fs.mkdir(path.dirname(centralFile), { recursive: true })
      const rows = Array.from({ length: 7 }, (_, i) => ({
        id: "r" + (i + 1),
        timestamp: "2026-09-" + String(i + 1).padStart(2, "0") + "T00:00:00.000Z",
        lesson: "rule " + (i + 1),
        source: "user_feedback",
      }))
      await fs.writeFile(centralFile, JSON.stringify(rows), "utf8")
      await fs.mkdir(path.dirname(wsFile), { recursive: true })
      await fs.writeFile(wsFile, JSON.stringify([rows[0]]), "utf8")

      const listed = await sessionObserver.listLearnings(ws)
      expect(listed.length).toBe(7)
      const injected = Object.fromEntries(listed.map((r) => [r.lesson, r.injected]))
      expect(injected["rule 1"]).toBe(true)
      expect(injected["rule 5"]).toBe(true)
      // newest by timestamp, but outside the first-five window the prompt actually uses
      expect(injected["rule 6"]).toBe(false)
      expect(injected["rule 7"]).toBe(false)
      expect(listed.find((r) => r.lesson === "rule 1")!.origin).toBe("central")

      expect(await sessionObserver.forgetLearning("rule 1", ws)).toBe(1)
      const after = await sessionObserver.listLearnings(ws)
      expect(after.map((r) => r.lesson)).not.toContain("rule 1")
      expect(await sessionObserver.forgetLearning("rule 1", ws)).toBe(0)
    } finally {
      process.env.USERPROFILE = prev
      await fs.rm(central, { recursive: true, force: true })
      await fs.rm(ws, { recursive: true, force: true })
    }
  })
})
