// #72: oc_close_session and oc_cleanup through the tool layer. Real workspaces on scratch git repos
// (workspaces-fixture.ts) behind a fake API and hub (tools-core-fixture.ts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { SessionState, SessionView } from "../src/shared/contracts.ts"
import type { Call } from "../src/shared/opencode-api.ts"
import { writeHostState, type HostSessionState } from "../src/supervisor/workspaces-state.ts"
import { cleanupTool, closeSessionTool } from "../src/tools/close-session.ts"
import { collectTool } from "../src/tools/collect.ts"
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

const view = (s: Started, state: SessionState): SessionView => ({ sessionID: s.sessionID, directory: `/sessions/${s.key}`, state, since: new Date().toISOString() })
const deleted = (f: Fake, sessionID: string) => f.api.find("DELETE", `/session/${sessionID}`) !== undefined
const aborted = (f: Fake, sessionID: string) => f.api.find("POST", `/session/${sessionID}/abort`) !== undefined

/** The session reports `before` until an abort was posted, then `after` (once `onAbort` has run). */
function busyUntilAbort(f: Fake, s: Started, before: SessionState, onAbort?: () => Promise<void>) {
  let ran = false
  f.hub.view = async (id: string) => {
    if (id !== s.sessionID || !aborted(f, id)) return view(s, before)
    if (!ran) {
      ran = true
      await onAbort?.()
    }
    return view(s, "idle")
  }
}

describe("oc_close_session", () => {
  test("is registered with honest destructive annotations and the split flags", () => {
    const tools = allTools()
    for (const name of ["oc_close_session", "oc_cleanup"]) expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(Object.keys(closeSessionTool.input).sort()).toEqual(["abort", "deleteBranch", "discardWork", "sessionID"])
  })

  test(
    "closes an idle session: DELETE, clone and record gone, untracked from the bridge",
    async () => {
      const f = context()
      const s = await start(f)
      const result = await invoke(closeSessionTool, { sessionID: s.sessionID }, f.ctx)
      expect(result.isError).toBeUndefined()
      expect(data(result)).toMatchObject({ sessionID: s.sessionID, sessionKey: s.key, closed: true, session: "deleted", clone: "removed", record: "removed", branch: "not_requested", uncollectedCommits: 0, aborted: false })
      expect(deleted(f, s.sessionID)).toBe(true)
      expect(fx.leftovers(s.key)).toEqual([])
      expect(existsSync(recordFile(s.key))).toBe(false)
      expect(f.ctx.sessions.has(s.sessionID)).toBe(false)
      expect(text(result)).not.toContain(fx.tmp)
    },
    T,
  )

  test(
    "a busy session is session_active without abort; abort: true stops it first, then closes",
    async () => {
      const f = context()
      const s = await start(f)
      busyUntilAbort(f, s, "busy")
      const refused = await invoke(closeSessionTool, { sessionID: s.sessionID }, f.ctx)
      expect(data(refused).code).toBe("session_active")
      expect(aborted(f, s.sessionID) || deleted(f, s.sessionID)).toBe(false)
      expect(existsSync(recordFile(s.key))).toBe(true)
      const stopped = await invoke(closeSessionTool, { sessionID: s.sessionID, abort: true }, f.ctx)
      expect(data(stopped)).toMatchObject({ closed: true, aborted: true })
      expect(f.order.indexOf(`POST /session/${s.sessionID}/abort`)).toBeLessThan(f.order.indexOf(`DELETE /session/${s.sessionID}`))
    },
    T,
  )

  test(
    "HIGH 2: work the aborted turn leaves is refused before DELETE, and oc_collect still works",
    async () => {
      const f = context()
      const s = await start(f)
      busyUntilAbort(f, s, "busy", () => fx.boxCommit(s.key, { "late.txt": "late\n" }, "late"))
      const refused = await invoke(closeSessionTool, { sessionID: s.sessionID, abort: true }, f.ctx)
      expect(data(refused).code).toBe("uncollected_work")
      expect(text(refused)).toContain("1 uncollected commit")
      expect(deleted(f, s.sessionID)).toBe(false)
      expect(f.ctx.sessions.has(s.sessionID)).toBe(true)
      expect(existsSync(recordFile(s.key))).toBe(true)
      const collected = await invoke(collectTool, { sessionID: s.sessionID }, f.ctx)
      expect(data(collected)).toMatchObject({ commits: 1 })
      const closed = await invoke(closeSessionTool, { sessionID: s.sessionID }, f.ctx)
      expect(data(closed)).toMatchObject({ closed: true })
    },
    T,
  )

  test(
    "uncollected commits are uncollected_work with the count; discardWork deletes them",
    async () => {
      const f = context()
      const s = await start(f)
      await fx.boxCommit(s.key, { "w.txt": "work\n" }, "work")
      const refused = await invoke(closeSessionTool, { sessionID: s.sessionID }, f.ctx)
      expect(data(refused).code).toBe("uncollected_work")
      expect(text(refused)).toContain("1 uncollected commit")
      expect(text(refused)).toContain("oc_collect")
      expect(deleted(f, s.sessionID)).toBe(false)
      expect(fx.leftovers(s.key)).toEqual([s.key])
      const discarded = await invoke(closeSessionTool, { sessionID: s.sessionID, discardWork: true }, f.ctx)
      expect(data(discarded)).toMatchObject({ closed: true, uncollectedCommits: 1 })
      expect(fx.leftovers(s.key)).toEqual([])
    },
    T,
  )

  test(
    "when the sandbox already lost the session, the refusal does not suggest oc_collect",
    async () => {
      const f = context()
      const s = await start(f, { track: false })
      await fx.boxCommit(s.key, { "w.txt": "work\n" }, "work")
      f.api.on(`GET /session/${s.sessionID}`, { status: 404 })
      const refused = await invoke(closeSessionTool, { sessionID: s.sessionID }, f.ctx)
      expect(data(refused).code).toBe("uncollected_work")
      expect(text(refused)).not.toContain("oc_collect")
    },
    T,
  )

  test(
    "MEDIUM 4: a state that cannot be verified is refused with a retry hint, never a force hint",
    async () => {
      const f = context()
      const s = await start(f)
      f.hub.views.set(s.sessionID, view(s, "unknown"))
      const refused = await invoke(closeSessionTool, { sessionID: s.sessionID, abort: true }, f.ctx)
      expect(refused.isError).toBe(true)
      expect(text(refused)).toMatch(/retry/i)
      expect(text(refused)).not.toMatch(/force|discardWork/)
      expect(aborted(f, s.sessionID) || deleted(f, s.sessionID)).toBe(false)
      f.hub.views.delete(s.sessionID)
      fx.boxOverride = (argv) => (argv[0] === "sh" ? { code: 125, stdout: "", stderr: "daemon down" } : undefined)
      const unchecked = await invoke(closeSessionTool, { sessionID: s.sessionID }, f.ctx)
      expect(text(unchecked)).not.toMatch(/force|discardWork/)
      expect(deleted(f, s.sessionID)).toBe(false)
    },
    T,
  )

  test(
    "MEDIUM 5: while a close runs, other tools refuse the session (session_active)",
    async () => {
      const f = context()
      const s = await start(f)
      const during: string[] = []
      busyUntilAbort(f, s, "busy", async () => {
        during.push(String(data(await invoke(collectTool, { sessionID: s.sessionID }, f.ctx)).code))
        during.push(String(data(await invoke(closeSessionTool, { sessionID: s.sessionID }, f.ctx)).code))
      })
      expect(data(await invoke(closeSessionTool, { sessionID: s.sessionID, abort: true }, f.ctx))).toMatchObject({ closed: true })
      expect(during).toEqual(["session_active", "session_active"])
    },
    T,
  )

  test(
    "another bridge's session is not_found and untouched",
    async () => {
      const f = context()
      const s = await start(f, { supervisor: "supervisor:other-bridge" })
      const before = readFileSync(recordFile(s.key), "utf8")
      const result = await invoke(closeSessionTool, { sessionID: s.sessionID, abort: true, discardWork: true, deleteBranch: true }, f.ctx)
      expect(data(result).code).toBe("not_found")
      expect(aborted(f, s.sessionID) || deleted(f, s.sessionID)).toBe(false)
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
    f.hub.views.set(busy.sessionID, view(busy, "needs_input"))
    const recent = await start(f, { ageDays: 30, updatedDaysAgo: 1, track: false })
    const other = await start(f, { ageDays: 30, supervisor: "supervisor:other-bridge" })
    const legacy = await start(f, { ageDays: 30, track: false })
    const { boxProject: _dropped, ...legacyState } = legacy.state
    writeHostState(stateDir(), legacyState)
    const ignored = await start(f, { ageDays: 30, track: false })
    appendFileSync(path.join(fx.boxClone(ignored.key), ".git", "info", "exclude"), ".env\n")
    writeFileSync(path.join(fx.boxClone(ignored.key), ".env"), "SECRET_NAME_ONLY=1\n")
    return { stale, uncollected, young, busy, recent, other, legacy, ignored }
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
      expect(d.kept).toEqual([
        { sessionKey: s.uncollected.key, reason: "uncollected_work", uncollectedCommits: 1, uncommittedPaths: 0, ignoredPaths: 0, discardedCommits: 0 },
        { sessionKey: s.ignored.key, reason: "ignored_files", uncollectedCommits: 0, uncommittedPaths: 0, ignoredPaths: 1, discardedCommits: 0 },
      ])
      expect(d.skipped).toMatchObject({ active: 1, recent: 1 })
      expect(d.legacyRecords).toBe(1)
      expect(Number(d.otherBridgeRecords)).toBeGreaterThanOrEqual(1)
      expect(text(dry)).toContain("OPENCODE_DELEGATE_NAME")
      expect(snapshot()).toEqual(before)
      expect(f.api.calls.some((c) => c.method === "DELETE" || c.path.endsWith("/abort"))).toBe(false)

      const real = await invoke(cleanupTool, { dryRun: false }, f.ctx)
      expect(data(real)).toMatchObject({ dryRun: false, closed: [s.stale.key], wouldClose: [] })
      expect(existsSync(recordFile(s.stale.key))).toBe(false)
      expect(fx.leftovers(s.stale.key)).toEqual([])
      expect(f.api.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([`/session/${s.stale.sessionID}`])
      expect(f.api.calls.some((c) => c.path.endsWith("/abort"))).toBe(false)
      for (const kept of [s.uncollected, s.young, s.busy, s.recent, s.other, s.legacy, s.ignored]) {
        expect(existsSync(recordFile(kept.key))).toBe(true)
        expect(fx.leftovers(kept.key)).toEqual([kept.key])
      }
    },
    T * 3,
  )

  test(
    "cycle 2: a sweep's late refusal keeps the host record on disk, and oc_collect still works after a bridge restart",
    async () => {
      const f = context()
      const s = await start(f, { ageDays: 30, track: false })
      const call = f.api.call.bind(f.api)
      f.api.call = async <T,>(input: Call) => {
        if (input.method === "DELETE" && input.path === `/session/${s.sessionID}`) await fx.boxCommit(s.key, { "race.txt": "race\n" }, "race")
        return call<T>(input)
      }
      const real = await invoke(cleanupTool, { dryRun: false }, f.ctx)
      expect((data(real).partial as string[]).includes(s.key)).toBe(true)
      expect(existsSync(recordFile(s.key))).toBe(true)
      expect(f.ctx.sessions.has(s.sessionID)).toBe(true)
      const restarted = context()
      const collected = await invoke(collectTool, { sessionID: s.sessionID }, restarted.ctx)
      expect(collected.isError).toBeUndefined()
      expect(data(collected)).toMatchObject({ commits: 1 })
    },
    T * 2,
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
