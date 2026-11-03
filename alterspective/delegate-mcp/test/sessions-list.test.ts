// #264: Bounded default oc_list_sessions and oc_status (no-arg), O(1) preloaded ownedStates lookup,
// and fast filtering of missing host worktrees without spawning git rev-parse.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DEFAULT_SESSION_LIMIT, listSessionsTool, statusTool } from "../src/tools/sessions-list.ts"
import { BASE, data, fakeContext, invoke, remoteSession, seedState } from "./tools-core-fixture.ts"

const LIST = "GET /experimental/session?roots=true&limit=200"

const tempDirs: string[] = []
function makeTempRepoDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ocd-slist-repo-"))
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("#264 bounded oc_list_sessions and oc_status with O(1) preloaded ownedStates", () => {
  test("oc_list_sessions({}) bounds 75 sessions to DEFAULT_SESSION_LIMIT (20) newest, filters missing hostRepo without resolveRepo, and reads disk states once", async () => {
    const f = fakeContext()
    const existingRepo = makeTempRepoDir()
    const missingRepo = path.join(os.tmpdir(), "ocd-nonexistent-worktree-path-999999")

    let listStatesCalls = 0
    let sessionStateCalls = 0
    const resolvedRepos: string[] = []

    const origList = f.ctx.workspaces.listSessionStates.bind(f.ctx.workspaces)
    const origGet = f.ctx.workspaces.sessionState.bind(f.ctx.workspaces)
    f.ctx.workspaces.listSessionStates = async () => {
      listStatesCalls++
      return origList()
    }
    f.ctx.workspaces.sessionState = async (key: string) => {
      sessionStateCalls++
      return origGet(key)
    }
    f.ctx.workspaces.resolveRepo = async (dir: string) => {
      resolvedRepos.push(dir)
      return dir
    }

    const remoteList = []
    // Seed 50 live sessions with an existing hostRepo on disk (createdAt / updated 1..50)
    for (let i = 1; i <= 50; i++) {
      const key = `s-${String(i).padStart(10, "0")}`
      const sid = `ses_${String(i).padStart(16, "0")}`
      const createdAt = new Date(1_700_000_000_000 + i * 1000).toISOString()
      seedState(f, { sessionKey: key, sessionID: sid, hostRepo: existingRepo, createdAt })
      const remote = remoteSession(f, {
        id: sid,
        directory: `/sessions/${key}`,
        metadata: { supervisor: f.ctx.supervisor, sessionKey: key },
        time: { created: 1_700_000_000_000 + i * 1000, updated: 1_700_000_000_000 + i * 1000 },
      })
      remoteList.push(remote)
      f.api.on(`GET /session/${sid}`, { status: 200, data: remote })
    }

    // Seed 25 sessions whose worktree path no longer exists on disk
    for (let i = 51; i <= 75; i++) {
      const key = `s-${String(i).padStart(10, "0")}`
      const sid = `ses_${String(i).padStart(16, "0")}`
      const createdAt = new Date(1_700_000_000_000 + i * 1000).toISOString()
      seedState(f, { sessionKey: key, sessionID: sid, hostRepo: missingRepo, createdAt })
      const remote = remoteSession(f, {
        id: sid,
        directory: `/sessions/${key}`,
        metadata: { supervisor: f.ctx.supervisor, sessionKey: key },
        time: { created: 1_700_000_000_000 + i * 1000, updated: 1_700_000_000_000 + i * 1000 },
      })
      remoteList.push(remote)
      f.api.on(`GET /session/${sid}`, { status: 200, data: remote })
    }

    f.api.on(LIST, { status: 200, data: remoteList })

    const res = await invoke(listSessionsTool, {}, f.ctx)
    const out = data(res)
    const sessions = out.sessions as Array<{ sessionID: string }>

    expect(sessions).toHaveLength(DEFAULT_SESSION_LIMIT)
    // Newest 20 valid sessions are 50 down to 31
    expect(sessions[0]?.sessionID).toBe(`ses_${String(50).padStart(16, "0")}`)
    expect(sessions[19]?.sessionID).toBe(`ses_${String(31).padStart(16, "0")}`)
    expect(out.totalCount).toBe(75)
    expect(out.filteredOutCount).toBe(55)
    expect(out.truncated).toBe(55)

    // Never called resolveRepo on the missing worktree path
    expect(resolvedRepos.includes(missingRepo)).toBe(false)
    expect(resolvedRepos).toHaveLength(DEFAULT_SESSION_LIMIT)
    // O(1) preloaded lookup: sessionState(key) is never called per row
    expect(sessionStateCalls).toBe(0)
    expect(listStatesCalls).toBe(1)
  })

  test("oc_list_sessions({ all: true }) returns all 75 sessions using O(1) preloaded lookup without calling resolveRepo on missing hostRepo", async () => {
    const f = fakeContext()
    const existingRepo = makeTempRepoDir()
    const missingRepo = path.join(os.tmpdir(), "ocd-nonexistent-worktree-path-888888")

    let sessionStateCalls = 0
    const resolvedRepos: string[] = []
    const origGet = f.ctx.workspaces.sessionState.bind(f.ctx.workspaces)
    f.ctx.workspaces.sessionState = async (key: string) => {
      sessionStateCalls++
      return origGet(key)
    }
    f.ctx.workspaces.resolveRepo = async (dir: string) => {
      resolvedRepos.push(dir)
      return dir
    }

    const remoteList = []
    for (let i = 1; i <= 25; i++) {
      const key = `s-${String(i).padStart(10, "0")}`
      const sid = `ses_${String(i).padStart(16, "0")}`
      const hostRepo = i <= 15 ? existingRepo : missingRepo
      seedState(f, { sessionKey: key, sessionID: sid, hostRepo })
      const remote = remoteSession(f, {
        id: sid,
        directory: `/sessions/${key}`,
        metadata: { supervisor: f.ctx.supervisor, sessionKey: key },
      })
      remoteList.push(remote)
      f.api.on(`GET /session/${sid}`, { status: 200, data: remote })
    }
    f.api.on(LIST, { status: 200, data: remoteList })

    const res = await invoke(listSessionsTool, { all: true }, f.ctx)
    const out = data(res)
    const sessions = out.sessions as Array<{ sessionID: string; state?: string }>

    expect(sessions).toHaveLength(25)
    expect(out.totalCount).toBe(25)
    expect(out.filteredOutCount).toBe(0)
    expect(sessionStateCalls).toBe(0)
    expect(resolvedRepos.includes(missingRepo)).toBe(false)
  })

  test("no-arg oc_status({}) bounds 70+ historical sessions to DEFAULT_SESSION_LIMIT (20) and skips missing hostRepo", async () => {
    const f = fakeContext()
    const existingRepo = makeTempRepoDir()
    const missingRepo = path.join(os.tmpdir(), "ocd-nonexistent-worktree-path-777777")
    const resolvedRepos: string[] = []
    f.ctx.workspaces.resolveRepo = async (dir: string) => {
      resolvedRepos.push(dir)
      return dir
    }

    // Track 1 active session in process
    const trackedSid = `ses_${String(999).padStart(16, "0")}`
    f.ctx.sessions.set(trackedSid, {
      sessionID: trackedSid,
      sessionKey: "s-0000000999",
      hostRepo: existingRepo,
      boxPath: "/sessions/s-0000000999",
      branch: "delegate/s-0000000999",
      profile: "standard",
      createdAt: new Date().toISOString(),
      base: BASE,
    })

    const remoteList = []
    for (let i = 1; i <= 70; i++) {
      const key = `s-${String(i).padStart(10, "0")}`
      const sid = `ses_${String(i).padStart(16, "0")}`
      const hostRepo = i <= 40 ? existingRepo : missingRepo
      const createdAt = new Date(1_700_000_000_000 + i * 1000).toISOString()
      seedState(f, { sessionKey: key, sessionID: sid, hostRepo, createdAt })
      const remote = remoteSession(f, {
        id: sid,
        directory: `/sessions/${key}`,
        metadata: { supervisor: f.ctx.supervisor, sessionKey: key },
      })
      remoteList.push(remote)
      f.api.on(`GET /session/${sid}`, { status: 200, data: remote })
    }
    f.api.on(LIST, { status: 200, data: remoteList })

    const res = await invoke(statusTool, {}, f.ctx)
    const out = data(res)
    const sessions = out.sessions as Array<{ sessionID: string; state: string }>

    expect(sessions).toHaveLength(DEFAULT_SESSION_LIMIT)
    expect(sessions[0]?.sessionID).toBe(trackedSid)
    expect(out.totalCount).toBe(71)
    expect(out.filteredOutCount).toBe(51)
    expect(resolvedRepos.includes(missingRepo)).toBe(false)
  })
})
