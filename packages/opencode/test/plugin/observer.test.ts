import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { defaultDiagnosticsLogDir, failedToolFromEvent, learningStorePaths, sessionObserver } from "../../src/plugin/observer"
import { SynapseAuthPlugin } from "../../src/plugin/synapse"
import { tmpdir } from "../fixture/fixture"
import * as fs from "fs/promises"
import * as path from "path"

// The observer has a fixed remote endpoint; intercept fetch so no test sends session data there.
let telemetry: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
beforeEach(() => {
  telemetry = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }))
})
afterEach(() => telemetry.mockRestore())

describe("session retrospective profile", () => {
  test.each([undefined, "0"])("keeps retrospective behavior when the flag is %s", async (value) => {
    await using ws = await tmpdir()
    const previous = process.env.OPENCODE_DISABLE_SESSION_RETROSPECTIVES
    if (value === undefined) delete process.env.OPENCODE_DISABLE_SESSION_RETROSPECTIVES
    if (value !== undefined) process.env.OPENCODE_DISABLE_SESSION_RETROSPECTIVES = value
    try {
      const sessionId = `obs-enabled-${value ?? "unset"}`
      sessionObserver.onToolBefore(sessionId, "read-1", "read", {})
      const retro = await sessionObserver.finalizeSessionRetrospective(sessionId, ws.path)
      if (!retro) throw new Error("no retrospective found")
      expect(retro.totalToolCalls).toBe(1)
      expect(sessionObserver.getLatestRetrospectives()).toContain(retro)
      const files = await fs.readdir(path.join(ws.path, ".system_generated", "retrospectives"))
      expect(files).toHaveLength(1)
      expect(await Bun.file(path.join(ws.path, ".system_generated", "retrospectives", files[0]!)).json()).toEqual(retro)
      expect(telemetry).toHaveBeenCalledTimes(1)
      expect(telemetry).toHaveBeenCalledWith("https://identity.alterspective.com.au/api/audit/session-retrospective", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(retro),
      })
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_DISABLE_SESSION_RETROSPECTIVES
      if (previous !== undefined) process.env.OPENCODE_DISABLE_SESSION_RETROSPECTIVES = previous
    }
  })

  test.each(["1", "true", "TRUE"])("disabled retrospectives (%s) do not write files or send telemetry", async (value) => {
    await using ws = await tmpdir()
    const previous = process.env.OPENCODE_DISABLE_SESSION_RETROSPECTIVES
    process.env.OPENCODE_DISABLE_SESSION_RETROSPECTIVES = value
    try {
      const sessionId = `obs-disabled-${value}`
      sessionObserver.onToolBefore(sessionId, "read-1", "read", {})
      sessionObserver.onToolAfter(sessionId, "read-1", "read", "ok")
      expect(await sessionObserver.finalizeSessionRetrospective(sessionId, ws.path)).toBeNull()
      expect(await fs.readdir(ws.path)).not.toContain(".system_generated")
      expect(sessionObserver.getLatestRetrospectives().some((retro) => retro.sessionId === sessionId)).toBe(false)
      expect(telemetry).not.toHaveBeenCalled()
      // Turning it back on must not replay records held while the profile was disabled.
      delete process.env.OPENCODE_DISABLE_SESSION_RETROSPECTIVES
      expect((await sessionObserver.finalizeSessionRetrospective(sessionId))?.totalToolCalls).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_DISABLE_SESSION_RETROSPECTIVES
      if (previous !== undefined) process.env.OPENCODE_DISABLE_SESSION_RETROSPECTIVES = previous
    }
  })
})

// #83: the learning store follows OPENCODE_TEST_HOME (set by test/preload.ts), so these tests
// redirect that, not USERPROFILE.
function restoreTestHome(value: string | undefined) {
  if (value === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = value
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
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
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
      restoreTestHome(prev)
    }
  })

  test("reports the real injection window and counts a rule once across both stores", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
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
      restoreTestHome(prev)
    }
  })

  test("re-recording a rule moves it to the front so it re-enters the window", async () => {
    await using home = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
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
      restoreTestHome(prev)
    }
  })

  test("forgetting keeps the row as a tombstone instead of deleting it", async () => {
    await using home = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
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
      restoreTestHome(prev)
    }
  })

  test("re-recording a forgotten rule revives it without duplicating", async () => {
    await using home = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
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
      restoreTestHome(prev)
    }
  })

  test("records the scope of each rule", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
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
      restoreTestHome(prev)
    }
  })

  test("a tombstone survives the record cap", async () => {
    await using home = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
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
      restoreTestHome(prev)
    }
  })

  test("forgetting still counts when the other store does not exist", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
    try {
      await sessionObserver.recordLearning({ lesson: "only global", source: "user_feedback" }, ws.path)
      // Remove the project store so only the global copy remains.
      await fs.rm(path.join(ws.path, ".system_generated", "logs", "learnings.json"), { force: true })

      expect(await sessionObserver.forgetLearning("only global", ws.path)).toBe(1)
    } finally {
      restoreTestHome(prev)
    }
  })

  test("forgetting reports nothing when a store is unreadable data", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
    try {
      await sessionObserver.recordLearning({ lesson: "fragile", source: "user_feedback" })
      // The project store exists but holds valid JSON that is not the expected array.
      const wsFile = path.join(ws.path, ".system_generated", "logs", "learnings.json")
      await fs.mkdir(path.dirname(wsFile), { recursive: true })
      await fs.writeFile(wsFile, JSON.stringify("not a rules array"), "utf8")

      expect(await sessionObserver.forgetLearning("fragile", ws.path)).toBe(0)
      // #38: a refused forget changes nothing; the global copy used to be tombstoned anyway.
      const global = JSON.parse(await fs.readFile(learningStorePaths().global!, "utf8"))
      expect(global.find((l: { lesson: string }) => l.lesson === "fragile")?.deletedAt).toBeUndefined()
      expect((await sessionObserver.listLearnings(ws.path)).map((l) => l.lesson)).toContain("fragile")
    } finally {
      restoreTestHome(prev)
    }
  })

  test("a refused forget leaves the project store alone when the global store is unreadable (#38)", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
    try {
      await sessionObserver.recordLearning({ lesson: "keep me", source: "user_feedback" }, ws.path)
      await fs.writeFile(learningStorePaths().global!, "{ not json", "utf8")
      const before = await fs.readFile(learningStorePaths(ws.path).project!, "utf8")

      expect(await sessionObserver.forgetLearning("keep me", ws.path)).toBe(0)
      expect(await fs.readFile(learningStorePaths(ws.path).project!, "utf8")).toBe(before)
    } finally {
      restoreTestHome(prev)
    }
  })

  test("recording a rule never overwrites a store it cannot read (#38)", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
    try {
      const project = learningStorePaths(ws.path).project!
      await fs.mkdir(path.dirname(project), { recursive: true })
      await fs.writeFile(project, "{ half-written", "utf8")

      const recorded = await sessionObserver.recordLearning({ lesson: "new rule", source: "user_feedback" }, ws.path)

      expect(recorded.savedTo).toEqual(["global"])
      expect(await fs.readFile(project, "utf8")).toBe("{ half-written")
      const global = JSON.parse(await fs.readFile(learningStorePaths().global!, "utf8")) as Array<{ lesson: string }>
      expect(global.map((l) => l.lesson)).toContain("new rule")
    } finally {
      restoreTestHome(prev)
    }
  })

  test("a store holding a malformed row counts as unreadable: forget changes nothing (CodeRabbit on #38)", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
    try {
      await sessionObserver.recordLearning({ lesson: "row check", source: "user_feedback" }, ws.path)
      await fs.writeFile(learningStorePaths(ws.path).project!, JSON.stringify([null, { lesson: "row check" }]), "utf8")
      const global = await fs.readFile(learningStorePaths().global!, "utf8")

      expect(await sessionObserver.forgetLearning("row check", ws.path)).toBe(0)
      expect(await fs.readFile(learningStorePaths().global!, "utf8")).toBe(global)
    } finally {
      restoreTestHome(prev)
    }
  })

  test("synapse_record_learning says when a rule was saved for this project only (CodeRabbit on #38)", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
    try {
      const global = learningStorePaths().global!
      await fs.mkdir(path.dirname(global), { recursive: true })
      await fs.writeFile(global, "{ broken", "utf8")
      const hooks = await SynapseAuthPlugin({
        client: {} as never,
        project: {} as never,
        directory: ws.path,
        worktree: "",
        experimental_workspace: { register() {} },
        serverUrl: new URL("https://example.com"),
        $: {} as never,
      } as never)
      const reply = await hooks.tool?.synapse_record_learning?.execute({ lesson: "local only" }, {} as never)
      expect(String(reply)).toContain("for this project only")
      expect(await fs.readFile(global, "utf8")).toBe("{ broken")
    } finally {
      restoreTestHome(prev)
    }
  })

  test("a refused forget says why: an unreadable store (#212)", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
    try {
      await sessionObserver.recordLearning({ lesson: "why refused", source: "user_feedback" }, ws.path)
      await fs.writeFile(learningStorePaths(ws.path).project!, "[bad", "utf8")
      expect(await sessionObserver.forgetLearningResult("why refused", ws.path)).toEqual({ forgotten: 0, refused: "unreadable" })
      expect(await sessionObserver.forgetLearningResult("no such rule", ws.path)).toEqual({ forgotten: 0, refused: "unreadable" })
    } finally {
      restoreTestHome(prev)
    }
  })

  // chmod does not stop writes on Windows.
  test.skipIf(process.platform === "win32")(
    "a forget whose second write fails puts the first store back (#212)",
    async () => {
      await using home = await tmpdir()
      await using ws = await tmpdir()
      const prev = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = home.path
      const projectDir = path.dirname(learningStorePaths(ws.path).project!)
      try {
        await sessionObserver.recordLearning({ lesson: "roll me back", source: "user_feedback" }, ws.path)
        await fs.chmod(projectDir, 0o555)
        // Root ignores the mode; then this case cannot be set up here.
        const probe = path.join(projectDir, "probe")
        if (await fs.writeFile(probe, "x").then(() => true, () => false)) {
          await fs.rm(probe)
          return
        }

        expect(await sessionObserver.forgetLearningResult("roll me back", ws.path)).toEqual({
          forgotten: 0,
          refused: "write_failed",
          restored: true,
        })
        const global = JSON.parse(await fs.readFile(learningStorePaths().global!, "utf8")) as Array<{
          lesson: string
          deletedAt?: string
        }>
        expect(global.find((l) => l.lesson === "roll me back")?.deletedAt).toBeUndefined()
      } finally {
        await fs.chmod(projectDir, 0o755).catch(() => {})
        restoreTestHome(prev)
      }
    },
  )

  test("listing and injection skip a store with a malformed row instead of throwing (#212)", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
    try {
      await sessionObserver.recordLearning({ lesson: "global survives", source: "user_feedback" })
      const project = learningStorePaths(ws.path).project!
      await fs.mkdir(path.dirname(project), { recursive: true })
      await fs.writeFile(project, JSON.stringify([null]), "utf8")

      expect((await sessionObserver.listLearnings(ws.path)).map((l) => l.lesson)).toContain("global survives")
      expect((await sessionObserver.getRecentLearnings(5, ws.path)).map((l) => l.lesson)).toContain("global survives")
    } finally {
      restoreTestHome(prev)
    }
  })

  test("synapse_forget_rule does not say 'No rule matched' when a store is unreadable (#212)", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
    try {
      await sessionObserver.recordLearning({ lesson: "still here", source: "user_feedback" }, ws.path)
      await fs.writeFile(learningStorePaths(ws.path).project!, "[bad", "utf8")
      const hooks = await SynapseAuthPlugin({
        client: {} as never,
        project: {} as never,
        directory: ws.path,
        worktree: "",
        experimental_workspace: { register() {} },
        serverUrl: new URL("https://example.com"),
        $: {} as never,
      } as never)
      const reply = String(await hooks.tool?.synapse_forget_rule?.execute({ lesson: "still here" }, {} as never))
      expect(reply).toContain("could not be read")
      expect(reply).not.toContain("No rule matched")
    } finally {
      restoreTestHome(prev)
    }
  })

  test("a rule recorded in a project is mirrored to the global store by design (#38)", async () => {
    await using home = await tmpdir()
    await using ws = await tmpdir()
    const prev = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
    try {
      const recorded = await sessionObserver.recordLearning({ lesson: "mirrored rule", source: "user_feedback" }, ws.path)
      expect(recorded.savedTo).toEqual(["global", "project"])
      const paths = learningStorePaths(ws.path)
      for (const file of [paths.global!, paths.project!]) {
        const rows = JSON.parse(await fs.readFile(file, "utf8")) as Array<{ lesson: string }>
        expect(rows.map((l) => l.lesson)).toContain("mirrored rule")
      }
      // One forget removes both copies and counts the rule once.
      expect(await sessionObserver.forgetLearning("mirrored rule", ws.path)).toBe(1)
      expect((await sessionObserver.listLearnings(ws.path)).map((l) => l.lesson)).not.toContain("mirrored rule")
    } finally {
      restoreTestHome(prev)
    }
  })
})

describe("observer paths (#83)", () => {
  const saved = { home: process.env.OPENCODE_TEST_HOME, diag: process.env.OPENCODE_DIAGNOSTICS_DIR }
  afterEach(() => {
    if (saved.home === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = saved.home
    if (saved.diag === undefined) delete process.env.OPENCODE_DIAGNOSTICS_DIR
    else process.env.OPENCODE_DIAGNOSTICS_DIR = saved.diag
  })

  test("the global learning store honours OPENCODE_TEST_HOME", async () => {
    await using tmp = await tmpdir()
    process.env.OPENCODE_TEST_HOME = tmp.path
    expect(learningStorePaths().global).toBe(path.join(tmp.path, ".local", "share", "opencode", "learnings.json"))
  })

  test("a broken OPENCODE_DIAGNOSTICS_DIR falls back to the default log folder", async () => {
    await using tmp = await tmpdir()
    process.env.OPENCODE_TEST_HOME = tmp.path
    // A file where the folder should be: mkdir and append both fail there.
    const notADir = path.join(tmp.path, "not-a-dir")
    await fs.writeFile(notADir, "x")
    process.env.OPENCODE_DIAGNOSTICS_DIR = notADir
    sessionObserver.logDiagnostic({ timestamp: new Date().toISOString(), type: "AUTH_EVENT", details: { marker: "obs-83-fallback" } })
    const log = path.join(defaultDiagnosticsLogDir()!, "diagnostics.log")
    let text = ""
    for (let i = 0; i < 50 && !text.includes("obs-83-fallback"); i++) {
      await new Promise((r) => setTimeout(r, 20))
      text = await fs.readFile(log, "utf8").catch(() => "")
    }
    expect(text).toContain("obs-83-fallback")
  })
})

// #18: opencode names MCP tools <server>_<tool>, so the old name check never matched them, and a
// failed call never reaches tool.execute.after at all.
describe("MCP tool failures with real remote tool names (#18)", () => {
  const mcpAnomalies = async (sessionId: string) => {
    const retro = await sessionObserver.finalizeSessionRetrospective(sessionId)
    if (!retro) throw new Error("no retrospective found")
    return retro.anomalies.filter((a) => a.type === "MCP_TOOL_FAILURE")
  }

  test("error words in a successful MCP result are data, not a failure (QA on #18)", async () => {
    const sessionId = "obs-18-shape"
    sessionObserver.onToolBefore(sessionId, "c1", "seqlogs_search", {})
    sessionObserver.onToolAfter(sessionId, "c1", "seqlogs_search", {
      content: [{ type: "text", text: "app error: ECONNRESET (recovered); Error: retry timed out" }],
    })
    expect(await mcpAnomalies(sessionId)).toEqual([])
  })

  test("a call the user stopped or refused, or a rule blocked, is not an MCP failure (QA on #18)", async () => {
    // #209: with a native tool known, the tool below counts as MCP, so this guards the skip list.
    sessionObserver.markNativeTool("read")
    const sessionId = "obs-18-refused"
    const errors = [
      "Tool execution aborted",
      "The user rejected permission to use this specific tool call.",
      "The user rejected permission to use this specific tool call with the following feedback: not now",
      'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules []',
      "The user dismissed this question",
    ]
    errors.forEach((error, i) => {
      sessionObserver.onToolBefore(sessionId, `c${i}`, "alterspective-rag_rag_search", {})
      sessionObserver.onToolFailed(sessionId, `c${i}`, "alterspective-rag_rag_search", error)
    })
    const retro = await sessionObserver.finalizeSessionRetrospective(sessionId)
    expect(retro?.totalToolCalls).toBe(errors.length)
    expect(retro?.anomalies.filter((a) => a.type === "MCP_TOOL_FAILURE")).toEqual([])
  })

  test("a retrospective covers the calls since the last one, so a failure is reported once (#209)", async () => {
    const sessionId = "obs-209-once"
    sessionObserver.onToolBefore(sessionId, "c1", "mcp__keystone__execute-tool", {})
    sessionObserver.onToolAfter(sessionId, "c1", "mcp__keystone__execute-tool", "Error: Unauthorized")
    const first = await sessionObserver.finalizeSessionRetrospective(sessionId)
    expect(first?.anomalies.filter((a) => a.type === "MCP_TOOL_FAILURE")).toHaveLength(1)
    // The next turn makes one clean call; the earlier failure is not reported again.
    sessionObserver.onToolBefore(sessionId, "c2", "read", {})
    sessionObserver.onToolAfter(sessionId, "c2", "read", "ok")
    const second = await sessionObserver.finalizeSessionRetrospective(sessionId)
    expect(second?.totalToolCalls).toBe(1)
    expect(second?.anomalies.filter((a) => a.type === "MCP_TOOL_FAILURE")).toEqual([])
  })

  test("an MCP result with isError set is flagged even when its text looks clean", async () => {
    const sessionId = "obs-18-iserror"
    sessionObserver.onToolBefore(sessionId, "c1", "alterspective-rag_rag_search", {})
    sessionObserver.onToolAfter(sessionId, "c1", "alterspective-rag_rag_search", {
      content: [{ type: "text", text: "quota reached" }],
      isError: true,
    })
    expect((await mcpAnomalies(sessionId)).map((a) => a.tool)).toEqual(["alterspective-rag_rag_search"])
  })

  test("a failed call is flagged from its stored part when the tool was never announced as native", async () => {
    sessionObserver.markNativeTool("read")
    const sessionId = "obs-18-failed"
    sessionObserver.onToolBefore(sessionId, "c1", "alterspective-rag_rag_search", {})
    sessionObserver.onToolFailed(sessionId, "c1", "alterspective-rag_rag_search", "MCP error -32001: Request timed out")
    sessionObserver.onToolBefore(sessionId, "c2", "read", {})
    sessionObserver.onToolFailed(sessionId, "c2", "read", "File not found: /tmp/x")
    const found = await mcpAnomalies(sessionId)
    expect(found.map((a) => a.tool)).toEqual(["alterspective-rag_rag_search"])
    expect(found[0]?.detail).toContain("Request timed out")
  })

  test("a failure for a call the observer never saw start is ignored (a fork or compaction replays old parts)", async () => {
    const sessionId = "obs-18-replay"
    sessionObserver.onToolFailed(sessionId, "old-call", "alterspective-rag_rag_search", "Error: old failure")
    const retro = await sessionObserver.finalizeSessionRetrospective(sessionId)
    expect(retro?.totalToolCalls).toBe(0)
    expect(retro?.anomalies.filter((a) => a.type === "MCP_TOOL_FAILURE")).toEqual([])
  })

  test("failedToolFromEvent reads only failed tool parts", () => {
    const part = { type: "tool", sessionID: "s1", callID: "c1", tool: "x_y", state: { status: "error", error: "boom" } }
    expect(failedToolFromEvent({ type: "message.part.updated", properties: { part } })).toEqual({
      sessionID: "s1",
      callID: "c1",
      tool: "x_y",
      error: "boom",
    })
    expect(failedToolFromEvent({ type: "message.part.updated", properties: { part: { ...part, state: { status: "completed" } } } })).toBeUndefined()
    expect(failedToolFromEvent({ type: "message.part.updated", properties: { part: { ...part, type: "text" } } })).toBeUndefined()
    expect(failedToolFromEvent({ type: "session.idle", properties: { part } })).toBeUndefined()
  })

  test("wiring: the Synapse plugin's hooks feed a failed MCP call into the retrospective", async () => {
    const hooks = await SynapseAuthPlugin({
      client: {} as never,
      project: {} as never,
      directory: "/test/dir",
      worktree: "",
      experimental_workspace: { register() {} },
      serverUrl: new URL("https://example.com"),
      $: {} as never,
    } as never)
    const sessionId = "obs-18-wiring"
    await hooks["tool.definition"]?.({ toolID: "bash" }, { description: "", parameters: {} })
    await hooks["tool.execute.before"]?.({ tool: "imprint_imprint_get_instructions", sessionID: sessionId, callID: "c1" }, { args: {} })
    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: sessionId,
            callID: "c1",
            tool: "imprint_imprint_get_instructions",
            state: { status: "error", error: "MCP error: Unauthorized" },
          },
        },
      } as never,
    })
    expect((await mcpAnomalies(sessionId)).map((a) => a.tool)).toEqual(["imprint_imprint_get_instructions"])
  })
})
