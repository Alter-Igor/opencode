// Regression tests for #263: requireDocker 5 s timeout + code_doctor recovery hint,
// invalidFolder OPENCODE_DELEGATE_ROOTS guidance, and delegate_task cleanup when send throws.
import { describe, expect, test } from "bun:test"
import { DelegateError } from "../src/shared/errors.ts"
import { requireDocker, type Exec } from "../src/supervisor/docker.ts"
import { invalidFolder } from "../src/supervisor/workspaces-exec.ts"
import type { CloseOptions } from "../src/supervisor/workspaces.ts"
import { delegateTaskTool } from "../src/tools/delegate-task.ts"
import { SID, data, fakeContext, invoke, remoteSession } from "./tools-core-fixture.ts"

describe("#263: preflight and failed-send cleanup", () => {
  test("requireDocker uses a 5 s timeout and names code_doctor { start: true } in its recovery action", async () => {
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
  })

  test("invalidFolder tells the caller how to configure OPENCODE_DELEGATE_ROOTS when a secondary drive or worktree is outside allowed roots", () => {
    const err = invalidFolder(["C:\\GitHub"], "The folder is outside the allowed roots.", "X:\\opencode---feature")
    expect(err.code).toBe("directory_invalid")
    expect(err.action).toContain("C:\\GitHub")
    expect(err.action).toContain("OPENCODE_DELEGATE_ROOTS")
  })

  test("delegate_task closes the newly created session when send throws, leaving no orphaned session", async () => {
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
})
