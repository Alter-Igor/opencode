// Tests for delegate_task (FEAT-CD-001): 1-step autonomous task delegation.
import { describe, expect, test } from "bun:test"
import { delegateTaskTool } from "../src/tools/delegate-task.ts"
import type { SessionState } from "../src/shared/contracts.ts"
import { BASE, SID, data, fakeContext, invoke, remoteSession, type Fake } from "./tools-core-fixture.ts"

function setupWorkingSession(f: Fake, sessionState: SessionState = "idle", assistantReply = "All tasks completed successfully.") {
  f.api.on("POST /session", { status: 200, data: { id: SID } })
  f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f) })
  f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "connected" } } })
  f.api.on(`POST /session/${SID}/prompt_async`, { status: 204 })
  f.api.on(`GET /session/${SID}/message?limit=8`, {
    status: 200,
    data: [
      {
        info: { id: "msg_001", role: "assistant" },
        parts: [{ type: "text", text: assistantReply }],
      },
    ],
  })
  f.api.on(`GET /session/${SID}/todo`, { status: 200, data: [] })

  f.setHost((argv) => {
    if (argv.includes("diff")) {
      return { code: 0, stdout: "src/feature.ts\ntest/feature.test.ts\n", stderr: "" }
    }
    return { code: 0, stdout: "", stderr: "" }
  })

  const view = { sessionID: SID, directory: "/sessions/s-001", state: sessionState, since: "2026-10-19T00:00:00Z" }
  f.hub.views.set(SID, view)
  f.hub.waitResult = {
    events: [],
    next: { epoch: "ep1", seq: 10 },
    timedOut: sessionState === "busy",
    views: [view],
  }
}

describe("delegate_task (FEAT-CD-001)", () => {
  test("happy path: starts, sends, waits until idle, collects, and returns structured summary", async () => {
    const f = fakeContext()
    setupWorkingSession(f, "idle", "Implemented the requested feature and added unit tests.")

    const result = await invoke(
      delegateTaskTool,
      {
        directory: "C:\\GitHub\\demo",
        prompt: "Please implement the new feature",
        engine: "auto",
      },
      f.ctx,
    )

    expect(result.isError).toBeUndefined()
    const d = data(result)
    expect(d.status).toBe("completed")
    expect(d.sessionID).toBe(SID)
    expect(String(d.branch)).toMatch(/^delegate\/s-[0-9a-f]{10}$/)
    expect(d.commits).toBe(1)
    expect(d.changedFiles).toEqual(["src/feature.ts", "test/feature.test.ts"])
    expect(d.filesCount).toBe(2)
    expect(d.summaryOfWork).toMatchObject({
      text: "Implemented the requested feature and added unit tests.",
    })
    expect(String(d.advice)).toContain("git diff")
    expect(String(d.advice)).toContain("code_close_session")
  })

  test("engine parameter resolves correctly for deepseek and opencode", async () => {
    const f = fakeContext()
    setupWorkingSession(f, "idle")

    await invoke(
      delegateTaskTool,
      {
        directory: "C:\\GitHub\\demo",
        prompt: "DeepSeek task",
        engine: "deepseek",
      },
      f.ctx,
    )

    const createCall = f.api.find("POST", "/session")
    expect(createCall).toBeDefined()
    expect(f.ctx.sessions.get(SID)?.agent).toBe("deepseek")
  })

  test("handles needs_input state gracefully with advice to use code_pending", async () => {
    const f = fakeContext()
    setupWorkingSession(f, "needs_input")

    const result = await invoke(
      delegateTaskTool,
      {
        directory: "C:\\GitHub\\demo",
        prompt: "Needs input prompt",
      },
      f.ctx,
    )

    expect(result.isError).toBeUndefined()
    const d = data(result)
    expect(d.status).toBe("needs_input")
    expect(d.sessionID).toBe(SID)
    expect(String(d.advice)).toContain("code_pending")
    expect(String(d.advice)).toContain("code_answer")
  })

  test("handles error state with scrubbed error message", async () => {
    const f = fakeContext()
    f.api.on("POST /session", { status: 200, data: { id: SID } })
    f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f) })
    f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "connected" } } })
    f.api.on(`POST /session/${SID}/prompt_async`, { status: 204 })

    const errorView = {
      sessionID: SID,
      directory: "/sessions/s-001",
      state: "error" as const,
      lastError: "TypeScript compilation failed with 2 errors",
      since: "2026-10-19T00:00:00Z",
    }
    f.hub.views.set(SID, errorView)
    f.hub.waitResult = {
      events: [],
      next: { epoch: "ep1", seq: 10 },
      timedOut: false,
      views: [errorView],
    }

    const result = await invoke(
      delegateTaskTool,
      {
        directory: "C:\\GitHub\\demo",
        prompt: "Failing prompt",
      },
      f.ctx,
    )

    expect(result.isError).toBeUndefined()
    const d = data(result)
    expect(d.status).toBe("failed")
    expect(d.sessionID).toBe(SID)
    expect(d.error).toBe("TypeScript compilation failed with 2 errors")
  })

  test("handles timeout while still working: keeps session alive and gives continuation advice", async () => {
    const f = fakeContext()
    setupWorkingSession(f, "busy")

    const result = await invoke(
      delegateTaskTool,
      {
        directory: "C:\\GitHub\\demo",
        prompt: "Long running task",
        timeoutMs: 200,
      },
      f.ctx,
    )

    expect(result.isError).toBeUndefined()
    const d = data(result)
    expect(d.status).toBe("timed_out")
    expect(d.sessionID).toBe(SID)
    expect(d.stillRunning).toBe(true)
    expect(String(d.advice)).toContain("code_wait")
    expect(String(d.advice)).toContain("code_abort")
  })
})
