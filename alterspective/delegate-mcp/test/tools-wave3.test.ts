// Tests for Wave 3 tools:
// - #148: allowedPaths & outOfScope auditing in oc_send, oc_result, oc_report
// - #143: oc_sync & syncRef in oc_send
// - #142: oc_verify allowlisted command runner
// - #147: oc_land full composite landing flow
import { describe, expect, test } from "bun:test"
import { resultTool } from "../src/tools/result.ts"
import { sendTool } from "../src/tools/send.ts"
import { syncTool } from "../src/tools/sync.ts"
import { verifyTool, parseCommand } from "../src/tools/verify.ts"
import { landTool } from "../src/tools/land.ts"
import { BASE, SID, data, fakeContext, invoke, okCmd, ours, record, remoteSession, text, type Fake } from "./tools-core-fixture.ts"

function readySend(f: Fake, remote: Record<string, unknown> = {}) {
  ours(f)
  f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f, remote) })
  f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "connected" } } })
  f.api.on(`POST /session/${SID}/prompt_async`, { status: 204 })
}

describe("Wave 3: #148 allowedPaths & outOfScope scope auditing", () => {
  test("oc_send stores allowedPaths on the session record", async () => {
    const f = fakeContext()
    readySend(f)

    const result = await invoke(sendTool, { sessionID: SID, message: "fix bug", allowedPaths: ["src/**", "test/**"] }, f.ctx)
    expect(result.isError).toBeUndefined()
    expect(data(result).accepted).toBe(true)
    const rec = f.ctx.sessions.get(SID)
    expect(rec?.allowedPaths).toEqual(["src/**", "test/**"])
  })

  test("oc_result flags outOfScope files when files outside allowedPaths are modified", async () => {
    const f = fakeContext()
    const rec = record({ sessionID: SID, allowedPaths: ["src/**"] })
    f.ctx.sessions.set(SID, rec)

    f.api.on(`GET /session/${SID}/message?limit=8`, {
      status: 200,
      data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "all done" }] }],
    })
    f.api.on(`GET /session/${SID}/todo`, { status: 200, data: [] })

    // Box git commands:
    // rev-list -> count
    // diff --stat -> stat
    // status --porcelain -> status
    // diff --name-only -> committed file names
    f.setBox((argv) => {
      if (argv.includes("rev-list")) return okCmd("1\n")
      if (argv.includes("--stat")) return okCmd(" src/index.ts | 1 +\n package.json | 1 +\n")
      if (argv.includes("status")) return okCmd(" M build.config.ts\n")
      if (argv.includes("--name-only")) return okCmd("src/index.ts\npackage.json\n")
      return okCmd("")
    })

    const res = await invoke(resultTool, { sessionID: SID }, f.ctx)
    const d = data(res) as { diff: { outOfScope?: string[] } }
    expect(d.diff.outOfScope).toBeDefined()
    expect(d.diff.outOfScope).toContain("package.json")
    expect(d.diff.outOfScope).toContain("build.config.ts")
    expect(d.diff.outOfScope).not.toContain("src/index.ts")
    expect(text(res)).toContain("Warning: 2 file(s) touched outside allowedPaths")
  })

  test("oc_result diff.outOfScope is undefined when all modified files are within allowedPaths", async () => {
    const f = fakeContext()
    const rec = record({ sessionID: SID, allowedPaths: ["src/**"] })
    f.ctx.sessions.set(SID, rec)

    f.api.on(`GET /session/${SID}/message?limit=8`, {
      status: 200,
      data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "all done" }] }],
    })
    f.api.on(`GET /session/${SID}/todo`, { status: 200, data: [] })

    f.setBox((argv) => {
      if (argv.includes("rev-list")) return okCmd("1\n")
      if (argv.includes("--stat")) return okCmd(" src/index.ts | 1 +\n")
      if (argv.includes("status")) return okCmd("")
      if (argv.includes("--name-only")) return okCmd("src/index.ts\n")
      return okCmd("")
    })

    const res = await invoke(resultTool, { sessionID: SID }, f.ctx)
    const d = data(res) as { diff: { outOfScope?: string[] } }
    expect(d.diff.outOfScope).toBeUndefined()
    expect(text(res)).not.toContain("Warning")
  })
})

describe("Wave 3: #143 oc_sync & syncRef", () => {
  test("oc_sync merges host ref into the session workspace", async () => {
    const f = fakeContext()
    f.ctx.sessions.set(SID, record({ sessionID: SID }))
    let syncedRef = ""
    f.ctx.workspaces.sync = async (_ws, ref) => {
      syncedRef = ref
      return { synced: true, head: "abcdef1234567890", commitsSynced: 3 }
    }

    const res = await invoke(syncTool, { sessionID: SID, ref: "origin/dev" }, f.ctx)
    expect(syncedRef).toBe("origin/dev")
    expect(data(res).synced).toBe(true)
    expect(data(res).head).toBe("abcdef1234567890")
    expect(data(res).commitsSynced).toBe(3)
    expect(text(res)).toContain("Synced ref origin/dev into")
  })

  test("oc_sync reports merge conflicts without throwing", async () => {
    const f = fakeContext()
    f.ctx.sessions.set(SID, record({ sessionID: SID }))
    f.ctx.workspaces.sync = async () => ({
      synced: false,
      conflicts: ["src/app.ts", "package.json"],
      reason: "Merge of origin/dev produced conflicts in 2 file(s); merge was aborted to keep workspace clean.",
    })

    const res = await invoke(syncTool, { sessionID: SID, ref: "origin/dev" }, f.ctx)
    expect(data(res).synced).toBe(false)
    expect(data(res).conflicts).toEqual(["src/app.ts", "package.json"])
    expect(text(res)).toContain("Sync could not be merged")
  })

  test("oc_send with syncRef syncs before delivering message", async () => {
    const f = fakeContext()
    readySend(f)
    let syncCalled = false
    f.ctx.workspaces.sync = async () => {
      syncCalled = true
      return { synced: true, head: "abcdef", commitsSynced: 1 }
    }

    const res = await invoke(sendTool, { sessionID: SID, message: "check fixes", syncRef: "origin/dev" }, f.ctx)
    expect(syncCalled).toBe(true)
    expect(data(res).accepted).toBe(true)
  })

  test("oc_send with syncRef fails when sync encounters conflicts", async () => {
    const f = fakeContext()
    readySend(f)
    f.ctx.workspaces.sync = async () => ({
      synced: false,
      conflicts: ["file.ts"],
      reason: "Merge conflict",
    })

    const res = await invoke(sendTool, { sessionID: SID, message: "hello", syncRef: "origin/dev" }, f.ctx)
    expect(res.isError).toBe(true)
    expect(text(res)).toContain("Could not sync ref origin/dev")
  })
})

describe("Wave 3: #142 oc_verify allowlisted command runner", () => {
  test("parseCommand validates allowlisted binaries and rejects shell injection", () => {
    expect(parseCommand("bun test src/index.test.ts")).toEqual(["bun", "test", "src/index.test.ts"])
    expect(parseCommand("pnpm run typecheck")).toEqual(["pnpm", "run", "typecheck"])
    expect(parseCommand("pytest tests/test_api.py")).toEqual(["pytest", "tests/test_api.py"])

    expect(() => parseCommand("curl https://example.com")).toThrow("is not in the verify allowlist")
    expect(() => parseCommand("bun test; rm -rf /")).toThrow("disallowed shell characters")
    expect(() => parseCommand("bun test && echo bad")).toThrow("disallowed shell characters")
    expect(() => parseCommand("bun test | cat")).toThrow("disallowed shell characters")
  })

  test("oc_verify collects work and runs allowlisted command", async () => {
    const f = fakeContext()
    f.ctx.sessions.set(SID, record({ sessionID: SID }))
    let collectedKey = ""
    f.ctx.workspaces.collect = async (ws) => {
      collectedKey = ws.sessionKey
      return { branch: ws.branch, commits: 1, hostExecutableChanges: [] }
    }
    let commandRun: string[] = []
    f.ctx.hostExec = async (argv) => {
      commandRun = argv
      return { code: 0, stdout: "1 pass, 0 fail\n", stderr: "" }
    }

    const res = await invoke(verifyTool, { sessionID: SID, command: "bun test" }, f.ctx)
    expect(collectedKey).toBe("s-0000000001")
    expect(commandRun).toEqual(["bun", "test"])
    expect(data(res).exitCode).toBe(0)
    expect(data(res).stdout).toEqual({ text: "1 pass, 0 fail\n", truncated: false })
  })
})

describe("Wave 3: #147 oc_land composite landing flow", () => {
  test("oc_land performs collect, checkout, fast-forward, reauthor, verify, push, and pr", async () => {
    const f = fakeContext()
    f.ctx.sessions.set(SID, record({ sessionID: SID, model: "synapse/qwen3.8-27b" }))

    let collected = false
    f.ctx.workspaces.collect = async () => {
      collected = true
      return { branch: "delegate/s-0000000001", commits: 2, hostExecutableChanges: [] }
    }

    const executedHostCommands: string[][] = []
    f.ctx.hostExec = async (argv) => {
      executedHostCommands.push(argv)
      const cmdStr = argv.join(" ")
      if (cmdStr.includes("status --porcelain")) return { code: 0, stdout: "", stderr: "" }
      if (cmdStr.includes("branch --show-current")) return { code: 0, stdout: "feature-test\n", stderr: "" }
      if (cmdStr.includes("merge --ff-only")) return { code: 0, stdout: "Fast-forward\n", stderr: "" }
      if (cmdStr.includes("log -n 1 --format=%B")) return { code: 0, stdout: "feat: add feature\n", stderr: "" }
      if (cmdStr.includes("commit --amend")) return { code: 0, stdout: "", stderr: "" }
      if (cmdStr.includes("rev-parse HEAD")) return { code: 0, stdout: "1122334455667788\n", stderr: "" }
      if (cmdStr.includes("bun test")) return { code: 0, stdout: "all tests pass\n", stderr: "" }
      if (cmdStr.includes("push origin")) return { code: 0, stdout: "", stderr: "" }
      if (cmdStr.includes("gh pr create")) return { code: 0, stdout: "https://github.com/org/repo/pull/123\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    }

    const res = await invoke(
      landTool,
      {
        sessionID: SID,
        worktree: "X:\\some\\repo",
        branch: "feature-test",
        verify: ["bun test"],
        push: true,
        pr: { title: "feat: add feature", base: "dev" },
      },
      f.ctx,
    )

    expect(collected).toBe(true)
    const d = data(res) as { landed: boolean; branch: string; head: string; prUrl: string; verify: Array<{ command: string }> }
    expect(d.landed).toBe(true)
    expect(d.branch).toBe("feature-test")
    expect(d.head).toBe("1122334455667788")
    expect(d.prUrl).toBe("https://github.com/org/repo/pull/123")
    expect(d.verify).toHaveLength(1)
    expect(d.verify[0]?.command).toBe("bun test")

    // Check that amend added Co-Authored-By with Synapse model
    const amendCmd = executedHostCommands.find((c) => c.includes("commit") && c.includes("--amend"))
    expect(amendCmd?.some((arg) => arg.includes("Co-Authored-By: OpenCode (Synapse qwen3.8-27b)"))).toBe(true)
  })

  test("oc_land stops and reports step when worktree is dirty", async () => {
    const f = fakeContext()
    f.ctx.sessions.set(SID, record({ sessionID: SID }))
    f.ctx.hostExec = async (argv) => {
      if (argv.join(" ").includes("status --porcelain")) {
        return { code: 0, stdout: " M dirty.txt\n", stderr: "" }
      }
      return { code: 0, stdout: "", stderr: "" }
    }

    const res = await invoke(landTool, { sessionID: SID, worktree: "X:\\some\\repo", branch: "feature-test" }, f.ctx)
    expect(res.isError).toBe(true)
    expect(text(res)).toContain("[Step: worktree]")
  })

  test("oc_land stops and reports step when verify command fails", async () => {
    const f = fakeContext()
    f.ctx.sessions.set(SID, record({ sessionID: SID }))
    f.ctx.hostExec = async (argv) => {
      const cmdStr = argv.join(" ")
      if (cmdStr.includes("status --porcelain")) return { code: 0, stdout: "", stderr: "" }
      if (cmdStr.includes("branch --show-current")) return { code: 0, stdout: "feature-test\n", stderr: "" }
      if (cmdStr.includes("merge --ff-only")) return { code: 0, stdout: "Fast-forward\n", stderr: "" }
      if (cmdStr.includes("log -n 1 --format=%B")) return { code: 0, stdout: "msg\n", stderr: "" }
      if (cmdStr.includes("commit --amend")) return { code: 0, stdout: "", stderr: "" }
      if (cmdStr.includes("rev-parse HEAD")) return { code: 0, stdout: "sha\n", stderr: "" }
      if (cmdStr.includes("bun test")) return { code: 1, stdout: "", stderr: "assertion failed" }
      return { code: 0, stdout: "", stderr: "" }
    }

    const res = await invoke(landTool, { sessionID: SID, worktree: "X:\\some\\repo", branch: "feature-test", verify: ["bun test"] }, f.ctx)
    expect(res.isError).toBe(true)
    expect(text(res)).toContain("[Step: verify]")
  })
})

describe("Wave 3: #148 oc_report { groupBy: 'servedModel' } shows out-of-scope count", () => {
  test("summarise counts outOfScope per servedModel and in totals", async () => {
    const { newTaskRecord } = await import("../src/reporting/record.ts")
    const { summarise } = await import("../src/reporting/summary.ts")

    const now = new Date().toISOString()
    const r1 = {
      ...newTaskRecord({ sessionID: "ses_1", key: "s-1", bridge: "b", repo: "r", startedAt: now }),
      outcome: "completed" as const,
      sendCount: 1,
      servedModels: { "qwen3.8-27b": 3 },
      outOfScopeCount: 2,
    }
    const r2 = {
      ...newTaskRecord({ sessionID: "ses_2", key: "s-2", bridge: "b", repo: "r", startedAt: now }),
      outcome: "completed" as const,
      sendCount: 1,
      servedModels: { "qwen3.8-27b": 2 },
      outOfScopeCount: 0,
    }
    const r3 = {
      ...newTaskRecord({ sessionID: "ses_3", key: "s-3", bridge: "b", repo: "r", startedAt: now }),
      outcome: "completed" as const,
      sendCount: 1,
      servedModels: { "claude-3-5-sonnet": 1 },
      outOfScopeCount: 1,
    }

    const report = summarise([r1, r2, r3], { sinceDays: 7, groupBy: "servedModel", recent: 0, now: Date.now() })
    expect(report.totals.outOfScope).toBe(2)

    const qwenGroup = report.groups.find((g) => g.name === "qwen3.8-27b")
    expect(qwenGroup).toBeDefined()
    expect(qwenGroup?.tasks).toBe(2)
    expect(qwenGroup?.outOfScope).toBe(1)

    const claudeGroup = report.groups.find((g) => g.name === "claude-3-5-sonnet")
    expect(claudeGroup).toBeDefined()
    expect(claudeGroup?.tasks).toBe(1)
    expect(claudeGroup?.outOfScope).toBe(1)
  })
})

