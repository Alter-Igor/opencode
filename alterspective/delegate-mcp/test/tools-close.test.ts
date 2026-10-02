// #72: oc_close_session and oc_cleanup through the tool layer. Real workspaces on scratch git repos
// (workspaces-fixture.ts) behind a fake API and hub (tools-core-fixture.ts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { writeHostState, type HostSessionState } from "../src/supervisor/workspaces-state.ts"
import { cleanupTool, closeSessionTool } from "../src/tools/close-session.ts"
import { allTools } from "../src/tools/index.ts"
import { data, fakeContext, invoke, text, type Fake } from "./tools-core-fixture.ts"
import { T, WorkspaceFixture } from "./workspaces-fixture.ts"

const fx = new WorkspaceFixture("ocd-tclose-")
beforeAll(() => fx.setup(), T)
beforeEach(() => {
  fx.boxOverride = undefined
})
afterAll(() => fx.teardown())

const TTL_ENV = "OPENCODE_DELEGATE_SESSION_TTL_DAYS"
const savedTtl = process.env[TTL_ENV]
afterEach(() => {
  if (savedTtl === undefined) delete process.env[TTL_ENV]
  else process.env[TTL_ENV] = savedTtl
})

const DAY = 24 * 60 * 60 * 1000
let serial = 0
const stateDir = () => path.join(fx.tmp, "state")
const recordFile = (key: string) => path.join(stateDir(), `${key}.json`)

function context(): Fake {
  const f = fakeContext()
  f.ctx.workspaces = fx.workspaces()
  return f
}

type Started = { key: string; sessionID: string; state: HostSessionState }

/** A bound session of `supervisor` (default: this bridge), with the box answering for it. */
async function start(f: Fake, options: { supervisor?: string; ageDays?: number; updatedDaysAgo?: number; track?: boolean } = {}): Promise<Started> {
  serial++
  const key = `tc-${String(serial).padStart(6, "0")}`
  const sessionID = `ses_${String(serial).padStart(18, "1")}`
  const ws = fx.workspaces()
  const opened = await ws.open(fx.hostRepo, key)
  let state = await ws.bindSession(key, { sessionID, profile: "standard", supervisor: options.supervisor ?? f.ctx.supervisor })
  if (options.ageDays !== undefined) {
    state = { ...state, createdAt: new Date(Date.now() - options.ageDays * DAY).toISOString() }
    writeHostState(stateDir(), state)
  }
  const updated = Date.now() - (options.updatedDaysAgo ?? options.ageDays ?? 0) * DAY
  const remote = { id: sessionID, directory: `/sessions/${key}`, title: "t", metadata: { supervisor: state.supervisor, sessionKey: key }, time: { created: updated, updated } }
  f.api.on(`GET /session/${sessionID}`, { status: 200, data: remote })
  f.api.on(`DELETE /session/${sessionID}`, { status: 200, data: true })
  f.api.on(`POST /session/${sessionID}/abort`, { status: 200, data: true })
  if (options.track !== false && (options.supervisor ?? f.ctx.supervisor) === f.ctx.supervisor)
    f.ctx.sessions.set(sessionID, { sessionID, sessionKey: key, hostRepo: opened.hostRepo, boxPath: opened.boxPath, branch: opened.branch, profile: "standard", createdAt: state.createdAt, base: opened.base })
  return { key, sessionID, state }
}

const deleted = (f: Fake, sessionID: string) => f.api.find("DELETE", `/session/${sessionID}`) !== undefined

describe("oc_close_session", () => {
  test("is registered with honest destructive annotations", () => {
    const tools = allTools()
    for (const name of ["oc_close_session", "oc_cleanup"]) {
      const tool = tools.find((t) => t.name === name)
      expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    }
  })

  test(
    "closes an idle session: DELETE, clone and record gone, untracked from the bridge",
    async () => {
      const f = context()
      const s = await start(f)
      const result = await invoke(closeSessionTool, { sessionID: s.sessionID }, f.ctx)
      expect(result.isError).toBeUndefined()
      expect(data(result)).toMatchObject({ sessionID: s.sessionID, sessionKey: s.key, closed: true, session: "deleted", clone: "removed", record: "removed", branch: "not_requested", uncollectedCommits: 0 })
      expect(deleted(f, s.sessionID)).toBe(true)
      expect(fx.leftovers(s.key)).toEqual([])
      expect(existsSync(recordFile(s.key))).toBe(false)
      expect(f.ctx.sessions.has(s.sessionID)).toBe(false)
      expect(text(result)).not.toContain(fx.tmp)
    },
    T,
  )

  test(
    "a busy session is refused without force; force aborts first and then closes",
    async () => {
      const f = context()
      const s = await start(f)
      f.hub.views.set(s.sessionID, { sessionID: s.sessionID, directory: `/sessions/${s.key}`, state: "busy", since: new Date().toISOString() })
      const refused = await invoke(closeSessionTool, { sessionID: s.sessionID }, f.ctx)
      expect(refused.isError).toBe(true)
      expect(data(refused).code).toBe("directory_busy")
      expect(deleted(f, s.sessionID)).toBe(false)
      expect(existsSync(recordFile(s.key))).toBe(true)
      const forced = await invoke(closeSessionTool, { sessionID: s.sessionID, force: true }, f.ctx)
      expect(data(forced)).toMatchObject({ closed: true, aborted: true })
      const abortAt = f.order.indexOf(`POST /session/${s.sessionID}/abort`)
      expect(abortAt).toBeGreaterThan(-1)
      expect(abortAt).toBeLessThan(f.order.indexOf(`DELETE /session/${s.sessionID}`))
    },
    T,
  )

  test(
    "uncollected commits are refused with the count; force deletes them",
    async () => {
      const f = context()
      const s = await start(f)
      await fx.boxCommit(s.key, { "w.txt": "work\n" }, "work")
      const refused = await invoke(closeSessionTool, { sessionID: s.sessionID }, f.ctx)
      expect(refused.isError).toBe(true)
      expect(text(refused)).toContain("1 uncollected commit")
      expect(deleted(f, s.sessionID)).toBe(false)
      expect(fx.leftovers(s.key)).toEqual([s.key])
      const forced = await invoke(closeSessionTool, { sessionID: s.sessionID, force: true }, f.ctx)
      expect(data(forced)).toMatchObject({ closed: true, uncollectedCommits: 1 })
      expect(fx.leftovers(s.key)).toEqual([])
    },
    T,
  )

  test(
    "another bridge's session is not_found and untouched",
    async () => {
      const f = context()
      const s = await start(f, { supervisor: "supervisor:other-bridge" })
      const before = readFileSync(recordFile(s.key), "utf8")
      const result = await invoke(closeSessionTool, { sessionID: s.sessionID, force: true, deleteBranch: true }, f.ctx)
      expect(data(result).code).toBe("not_found")
      expect(deleted(f, s.sessionID)).toBe(false)
      expect(readFileSync(recordFile(s.key), "utf8")).toBe(before)
      expect(fx.leftovers(s.key)).toEqual([s.key])
    },
    T,
  )

  test(
    "a session the sandbox already lost is found through the host record and cleaned up",
    async () => {
      const f = context()
      const s = await start(f, { track: false })
      f.api.on(`GET /session/${s.sessionID}`, { status: 404 })
      f.api.on(`DELETE /session/${s.sessionID}`, { status: 404 })
      const result = await invoke(closeSessionTool, { sessionID: s.sessionID }, f.ctx)
      expect(data(result)).toMatchObject({ closed: true, session: "already_gone", clone: "removed", record: "removed" })
    },
    T,
  )
})

describe("oc_cleanup", () => {
  async function scene(f: Fake) {
    const stale = await start(f, { ageDays: 30, track: false })
    const uncollected = await start(f, { ageDays: 30, track: false })
    await fx.boxCommit(uncollected.key, { "u.txt": "keep\n" }, "keep")
    const young = await start(f, { track: false })
    const busy = await start(f, { ageDays: 30, track: false })
    f.hub.views.set(busy.sessionID, { sessionID: busy.sessionID, directory: `/sessions/${busy.key}`, state: "needs_input", since: new Date().toISOString() })
    const recent = await start(f, { ageDays: 30, updatedDaysAgo: 1, track: false })
    const other = await start(f, { ageDays: 30, supervisor: "supervisor:other-bridge" })
    const legacy = await start(f, { ageDays: 30, track: false })
    const { boxProject: _dropped, ...legacyState } = legacy.state
    writeHostState(stateDir(), legacyState)
    return { stale, uncollected, young, busy, recent, other, legacy }
  }

  test(
    "dry run (the default) lists what it would remove and changes nothing; a real run removes only eligible sessions",
    async () => {
      const f = context()
      const s = await scene(f)
      const snapshot = () => Object.values(s).map((x) => [existsSync(recordFile(x.key)), fx.leftovers(x.key).length])
      const before = snapshot()
      const dry = await invoke(cleanupTool, {}, f.ctx)
      expect(dry.isError).toBeUndefined()
      const d = data(dry)
      expect(d).toMatchObject({ dryRun: true, ttlDays: 14, wouldClose: [s.stale.key], closed: [] })
      expect(d.kept).toEqual([{ sessionKey: s.uncollected.key, reason: "uncollected_work", uncollectedCommits: 1, uncommittedPaths: 0 }])
      expect(d.skipped).toMatchObject({ active: 1, recent: 1 })
      expect(d.legacyRecords).toBe(1)
      expect(snapshot()).toEqual(before)
      expect(f.api.calls.some((c) => c.method === "DELETE")).toBe(false)

      const real = await invoke(cleanupTool, { dryRun: false }, f.ctx)
      expect(data(real)).toMatchObject({ dryRun: false, closed: [s.stale.key], wouldClose: [] })
      expect(existsSync(recordFile(s.stale.key))).toBe(false)
      expect(fx.leftovers(s.stale.key)).toEqual([])
      expect(f.api.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([`/session/${s.stale.sessionID}`])
      for (const kept of [s.uncollected, s.young, s.busy, s.recent, s.other, s.legacy]) {
        expect(existsSync(recordFile(kept.key))).toBe(true)
        expect(fx.leftovers(kept.key)).toEqual([kept.key])
      }
    },
    T * 3,
  )

  test("a TTL of 0 disables the sweep", async () => {
    process.env[TTL_ENV] = "0"
    const f = context()
    const result = await invoke(cleanupTool, { dryRun: false }, f.ctx)
    expect(data(result)).toMatchObject({ disabled: true, closed: [] })
    expect(f.api.calls).toEqual([])
  })

  test("a TTL that is not a whole number of days is refused", async () => {
    process.env[TTL_ENV] = "two weeks"
    const result = await invoke(cleanupTool, {}, context().ctx)
    expect(data(result).code).toBe("invalid_input")
  })
})
