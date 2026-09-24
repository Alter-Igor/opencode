import { describe, expect, test } from "bun:test"
import { sessionObserver } from "../../src/plugin/observer"
import { tmpdir } from "../fixture/fixture"
import * as fs from "fs/promises"
import * as path from "path"

function restoreUserProfile(value: string | undefined) {
  if (value === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = value
}

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
  test("injects a rule that exists only in the project store", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.USERPROFILE
    process.env.USERPROFILE = home.path
    try {
      const wsFile = path.join(ws.path, ".system_generated", "logs", "learnings.json")
      await fs.mkdir(path.dirname(wsFile), { recursive: true })
      await fs.writeFile(
        wsFile,
        JSON.stringify([
          { id: "p1", timestamp: "2026-09-23T00:00:00.000Z", lesson: "project only rule", source: "user_feedback" },
        ]),
        "utf8",
      )
      const row = (await sessionObserver.listLearnings(ws.path)).find((r) => r.lesson === "project only rule")!
      expect(row.origin).toBe("project")
      expect(row.injected).toBe(true)
    } finally {
      restoreUserProfile(prev)
    }
  })

  test("reports the real injection window and counts a rule once across both stores", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.USERPROFILE
    process.env.USERPROFILE = home.path
    try {
      const globalFile = path.join(home.path, ".local", "share", "opencode", "learnings.json")
      await fs.mkdir(path.dirname(globalFile), { recursive: true })
      const rows = Array.from({ length: 7 }, (_, i) => ({
        id: "r" + (i + 1),
        timestamp: "2026-09-" + String(i + 1).padStart(2, "0") + "T00:00:00.000Z",
        lesson: "rule " + (i + 1),
        source: "user_feedback",
      }))
      await fs.writeFile(globalFile, JSON.stringify(rows), "utf8")
      const wsFile = path.join(ws.path, ".system_generated", "logs", "learnings.json")
      await fs.mkdir(path.dirname(wsFile), { recursive: true })
      await fs.writeFile(wsFile, JSON.stringify([rows[0]]), "utf8")

      const listed = await sessionObserver.listLearnings(ws.path)
      expect(listed.length).toBe(7)
      const injected = Object.fromEntries(listed.map((r) => [r.lesson, r.injected]))
      expect(injected["rule 1"]).toBe(true)
      expect(injected["rule 5"]).toBe(true)
      // newest by timestamp, but outside the first-five window the prompt actually uses
      expect(injected["rule 6"]).toBe(false)
      expect(injected["rule 7"]).toBe(false)
      expect(listed.find((r) => r.lesson === "rule 1")!.origin).toBe("global")

      expect(await sessionObserver.forgetLearning("rule 1", ws.path)).toBe(1)
      expect((await sessionObserver.listLearnings(ws.path)).map((r) => r.lesson)).not.toContain("rule 1")
      expect(await sessionObserver.forgetLearning("rule 1", ws.path)).toBe(0)
    } finally {
      restoreUserProfile(prev)
    }
  })

  test("re-recording a rule moves it to the front so it re-enters the window", async () => {
    await using home = await tmpdir()
    const prev = process.env.USERPROFILE
    process.env.USERPROFILE = home.path
    try {
      const file = path.join(home.path, ".local", "share", "opencode", "learnings.json")
      await fs.mkdir(path.dirname(file), { recursive: true })
      const rows = Array.from({ length: 6 }, (_, i) => ({
        id: "r" + (i + 1),
        timestamp: "2026-09-0" + (i + 1) + "T00:00:00.000Z",
        lesson: "rule " + (i + 1),
        source: "user_feedback",
      }))
      await fs.writeFile(file, JSON.stringify(rows), "utf8")

      expect((await sessionObserver.listLearnings()).find((r) => r.lesson === "rule 6")!.injected).toBe(false)

      await sessionObserver.recordLearning({ lesson: "rule 6", source: "user_feedback" })

      const after = await sessionObserver.listLearnings()
      expect(after.find((r) => r.lesson === "rule 6")!.injected).toBe(true)
      expect(after.length).toBe(6)
    } finally {
      restoreUserProfile(prev)
    }
  })

  test("forgetting keeps the row as a tombstone instead of deleting it", async () => {
    await using home = await tmpdir()
    const prev = process.env.USERPROFILE
    process.env.USERPROFILE = home.path
    try {
      const file = path.join(home.path, ".local", "share", "opencode", "learnings.json")
      await sessionObserver.recordLearning({ lesson: "tombstone me", source: "user_feedback" })
      expect(await sessionObserver.forgetLearning("tombstone me")).toBe(1)

      expect((await sessionObserver.listLearnings()).find((r) => r.lesson === "tombstone me")).toBeUndefined()

      const rows = JSON.parse(await fs.readFile(file, "utf8"))
      const row = rows.find((r: { lesson: string }) => r.lesson === "tombstone me")
      expect(row).toBeDefined()
      expect(typeof row.deletedAt).toBe("string")
      expect(row.scope).toBe("global")
    } finally {
      restoreUserProfile(prev)
    }
  })

  test("re-recording a forgotten rule revives it without duplicating", async () => {
    await using home = await tmpdir()
    const prev = process.env.USERPROFILE
    process.env.USERPROFILE = home.path
    try {
      const file = path.join(home.path, ".local", "share", "opencode", "learnings.json")
      await sessionObserver.recordLearning({ lesson: "revive me", source: "user_feedback" })
      expect(await sessionObserver.forgetLearning("revive me")).toBe(1)
      expect((await sessionObserver.listLearnings()).find((r) => r.lesson === "revive me")).toBeUndefined()

      await sessionObserver.recordLearning({ lesson: "revive me", source: "user_feedback" })

      expect((await sessionObserver.listLearnings()).find((r) => r.lesson === "revive me")!.injected).toBe(true)
      const rows = JSON.parse(await fs.readFile(file, "utf8"))
      const rowsForLesson = rows.filter((r: { lesson: string }) => r.lesson === "revive me")
      expect(rowsForLesson.length).toBe(1)
      expect(rowsForLesson[0].deletedAt).toBeUndefined()
    } finally {
      restoreUserProfile(prev)
    }
  })

  test("records the scope of each rule", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.USERPROFILE
    process.env.USERPROFILE = home.path
    try {
      await sessionObserver.recordLearning({ lesson: "global rule", source: "user_feedback" })
      await sessionObserver.recordLearning({ lesson: "project rule", source: "user_feedback" }, ws.path)

      const global = JSON.parse(
        await fs.readFile(path.join(home.path, ".local", "share", "opencode", "learnings.json"), "utf8"),
      )
      const project = JSON.parse(
        await fs.readFile(path.join(ws.path, ".system_generated", "logs", "learnings.json"), "utf8"),
      )
      expect(global.find((r: { lesson: string }) => r.lesson === "global rule").scope).toBe("global")
      expect(project.find((r: { lesson: string }) => r.lesson === "project rule").scope).toBe("project")
    } finally {
      restoreUserProfile(prev)
    }
  })

  test("a tombstone survives the record cap", async () => {
    await using home = await tmpdir()
    const prev = process.env.USERPROFILE
    process.env.USERPROFILE = home.path
    try {
      const file = path.join(home.path, ".local", "share", "opencode", "learnings.json")
      const rows: Array<{
        id: string
        timestamp: string
        lesson: string
        source: string
        deletedAt?: string
        deletedBy?: string
      }> = Array.from({ length: 100 }, (_, i) => ({
        id: "r" + i,
        timestamp: "2026-09-01T00:00:00.000Z",
        lesson: "rule " + i,
        source: "user_feedback",
      }))
      rows.push({
        id: "dead",
        timestamp: "2026-09-01T00:00:00.000Z",
        lesson: "tombstoned rule",
        source: "user_feedback",
        deletedAt: "2026-09-02T00:00:00.000Z",
        deletedBy: "test",
      })
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, JSON.stringify(rows), "utf8")

      await sessionObserver.recordLearning({ lesson: "one more", source: "user_feedback" })

      const after = JSON.parse(await fs.readFile(file, "utf8"))
      const tomb = after.find((r: { lesson: string }) => r.lesson === "tombstoned rule")
      expect(tomb).toBeDefined()
      expect(tomb.deletedAt).toBe("2026-09-02T00:00:00.000Z")
    } finally {
      restoreUserProfile(prev)
    }
  })

  test("forgetting still counts when the other store does not exist", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.USERPROFILE
    process.env.USERPROFILE = home.path
    try {
      await sessionObserver.recordLearning({ lesson: "only global", source: "user_feedback" }, ws.path)
      // Remove the project store so only the global copy remains.
      await fs.rm(path.join(ws.path, ".system_generated", "logs", "learnings.json"), { force: true })

      expect(await sessionObserver.forgetLearning("only global", ws.path)).toBe(1)
    } finally {
      restoreUserProfile(prev)
    }
  })

  test("forgetting reports nothing when a store is unreadable data", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.USERPROFILE
    process.env.USERPROFILE = home.path
    try {
      await sessionObserver.recordLearning({ lesson: "fragile", source: "user_feedback" })
      // The project store exists but holds valid JSON that is not the expected array.
      const wsFile = path.join(ws.path, ".system_generated", "logs", "learnings.json")
      await fs.mkdir(path.dirname(wsFile), { recursive: true })
      await fs.writeFile(wsFile, JSON.stringify("not a rules array"), "utf8")

      expect(await sessionObserver.forgetLearning("fragile", ws.path)).toBe(0)
    } finally {
      restoreUserProfile(prev)
    }
  })
})
