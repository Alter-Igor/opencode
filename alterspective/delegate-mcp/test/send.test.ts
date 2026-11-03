// Regression tests for #263: requireDocker 5 s timeout + code_doctor recovery hint (including statusOf),
// outsideRoots vs invalidFolder OPENCODE_DELEGATE_ROOTS guidance, and delegate_task cleanup / retention when send fails.
import { describe, expect, test } from "bun:test"
import { defaultConfig } from "../src/shared/config.ts"
import { DelegateError } from "../src/shared/errors.ts"
import { requireDocker, type Exec } from "../src/supervisor/docker.ts"
import { statusOf } from "../src/supervisor/status.ts"
import type { Run } from "../src/supervisor/run.ts"
import { invalidFolder, outsideRoots } from "../src/supervisor/workspaces-exec.ts"
import type { CloseOptions } from "../src/supervisor/workspaces.ts"
import { delegateTaskTool } from "../src/tools/delegate-task.ts"
import { FIXTURE_HOME, SID, data, fakeContext, invoke, remoteSession } from "./tools-core-fixture.ts"

describe("#263: preflight and failed-send cleanup", () => {
  test("requireDocker uses a 5 s timeout and names code_doctor { start: true } in its recovery action, and statusOf preserves that action", async () => {
    let seenTimeout: number | undefined
    const exec: Exec = async (_argv, options) => {
      seenTimeout = options?.timeoutMs
      return { code: 1, stdout: "", stderr: "error during connect: pipe not found" }
    }
    let caught: unknown
    try {
      await requireDocker(exec)
    } catch (e) {
      caught = e
    }
    expect(seenTimeout).toBe(5_000)
    expect(caught).toBeInstanceOf(DelegateError)
    const err = caught as DelegateError
    expect(err.code).toBe("sandbox_unavailable")
    expect(err.action).toContain("code_doctor { start: true }")
    expect(err.action).toContain("oc_doctor { start: true }")

    const status = await statusOf({
      deps: { config: { ...defaultConfig({}), home: FIXTURE_HOME }, exec, image: "opencode-delegate-box:test", buildSha: "1234567" },
      container: "opencode-delegate",
      state: { startedHere: false },
      note: () => {},
    } as unknown as Run)
    expect(status.state).toBe("unavailable")
    if (status.state === "unavailable") {
      expect(status.action).toContain("code_doctor { start: true }")
      expect(status.action).toContain("oc_doctor { start: true }")
    }
  })

  test("outsideRoots tells the caller how to configure OPENCODE_DELEGATE_ROOTS, while invalidFolder keeps generic guidance when roots are configured", () => {
    const outside = outsideRoots(["C:\\GitHub"], "The folder is outside the allowed roots.", "X:\\opencode---feature")
    expect(outside.code).toBe("directory_invalid")
    expect(outside.action).toContain("C:\\GitHub")
    expect(outside.action).toContain("OPENCODE_DELEGATE_ROOTS")
    expect(outside.action).toContain("C:\\GitHub;X:\\")
    expect(outside.action).toContain("restart the MCP client")

    const invalid = invalidFolder(["C:\\GitHub"], "The folder is not a git work tree.", "C:\\GitHub\\not-git")
    expect(invalid.code).toBe("directory_invalid")
    expect(invalid.action).toContain("C:\\GitHub")
    expect(invalid.action).not.toContain("To allow a secondary drive")
  })

  test("delegate_task closes the newly created session on confirmed non-2xx send rejection, leaving no orphaned session", async () => {
    const f = fakeContext()
    const closedCalls: Array<{ sessionKey: string; options: CloseOptions }> = []
    f.ctx.workspaces.closeSession = async (sessionKey, owner, options, hooks) => {
      closedCalls.push({ sessionKey, options })
      await hooks.stop()
      const session = await hooks.deleteSession()
      f.states.delete(sessionKey)
      return {
        closed: true,
        sessionID: owner.sessionID,
        sessionKey,
        session,
        clone: "removed",
        record: "removed",
        branch: "absent",
        uncollectedCommits: 0,
        uncommittedPaths: 0,
        ignoredPaths: 0,
        ignoredExamples: [],
        discardedCommits: 0,
      }
    }

    f.api.on("POST /session", { status: 200, data: { id: SID } })
    f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f) })
    f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "connected" } } })
    f.api.on(`POST /session/${SID}/prompt_async`, { status: 500 })
    f.api.on(`DELETE /session/${SID}`, { status: 200, data: true })
    f.hub.views.set(SID, { sessionID: SID, directory: "/sessions/s-001", state: "idle", since: "2026-10-19T00:00:00Z" })

    const result = await invoke(
      delegateTaskTool,
      {
        directory: "C:\\GitHub\\demo",
        prompt: "Task whose send fails",
      },
      f.ctx,
    )

    expect(result.isError).toBe(true)
    expect(data(result).code).toBe("upstream_error")
    expect(f.api.find("DELETE", `/session/${SID}`)).toBeDefined()
    expect(f.ctx.sessions.has(SID)).toBe(false)
    expect(closedCalls).toHaveLength(1)
    expect(closedCalls[0]?.options).toEqual({ discardWork: true, deleteBranch: true })
  })

  test("delegate_task reports incomplete cleanup (closed: false or thrown cleanup error) with sessionID and oc_list_sessions while preserving send error code", async () => {
    const f = fakeContext()
    f.ctx.workspaces.closeSession = async (sessionKey, owner, _options, hooks) => {
      await hooks.stop()
      const session = await hooks.deleteSession()
      return {
        closed: false,
        sessionID: owner.sessionID,
        sessionKey,
        session,
        clone: "failed",
        record: "kept",
        branch: "kept_unknown",
        uncollectedCommits: 0,
        uncommittedPaths: 0,
        ignoredPaths: 0,
        ignoredExamples: [],
        discardedCommits: 0,
      }
    }

    f.api.on("POST /session", { status: 200, data: { id: SID } })
    f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f) })
    f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "connected" } } })
    f.api.on(`POST /session/${SID}/prompt_async`, { status: 500 })
    f.api.on(`DELETE /session/${SID}`, { status: 200, data: true })
    f.hub.views.set(SID, { sessionID: SID, directory: "/sessions/s-001", state: "idle", since: "2026-10-19T00:00:00Z" })

    const result = await invoke(
      delegateTaskTool,
      {
        directory: "C:\\GitHub\\demo",
        prompt: "Task whose cleanup is partial",
      },
      f.ctx,
    )

    expect(result.isError).toBe(true)
    const d = data(result)
    expect(d.code).toBe("upstream_error")
    expect(String(d.message)).toContain(SID)
    expect(String(d.message)).toContain("closed=false")
    expect(String(d.action)).toContain("oc_list_sessions")
  })

  test("delegate_task retains the session and surfaces sessionID when a transport error leaves prompt acceptance uncertain", async () => {
    const f = fakeContext()
    let closeCalled = false
    f.ctx.workspaces.closeSession = async () => {
      closeCalled = true
      throw new Error("should not be called")
    }

    f.api.on("POST /session", { status: 200, data: { id: SID } })
    f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f) })
    f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "connected" } } })
    f.api.on(`POST /session/${SID}/prompt_async`, new DelegateError("server_down", "The delegate server did not answer in time.", "Run oc_doctor.", "timeout"))

    const result = await invoke(
      delegateTaskTool,
      {
        directory: "C:\\GitHub\\demo",
        prompt: "Task with ambiguous transport timeout",
      },
      f.ctx,
    )

    expect(result.isError).toBe(true)
    const d = data(result)
    expect(d.code).toBe("server_down")
    expect(String(d.message)).toContain(SID)
    expect(String(d.action)).toContain(SID)
    expect(String(d.action)).toContain("oc_list_sessions")
    expect(closeCalled).toBe(false)
    expect(f.ctx.sessions.has(SID)).toBe(true)
  })
})
