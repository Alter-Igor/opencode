import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createWorkspaces, type ExecResult } from "../src/supervisor/workspaces.ts"
import { writeHostState, type HostSessionState } from "../src/supervisor/workspaces-state.ts"
import { listSessionsTool } from "../src/tools/sessions.ts"
import { collectTool } from "../src/tools/collect.ts"
import { BASE, fakeContext, invoke, record } from "./tools-core-fixture.ts"
import { T, WorkspaceFixture } from "./workspaces-fixture.ts"

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "ocd-prune-"))
  homes.push(home)
  const f = fakeContext()
  const stateDir = path.join(home, "workspaces")
  const probes: string[][] = []
  const probe = { result: { code: 44, stdout: "", stderr: "" } as ExecResult }
  const beforeProbe: { run?: () => Promise<void> | void } = {}
  const workspaces = () => createWorkspaces({
    config: { ...f.ctx.config, home }, container: "unused", stateDir,
    boxExec: async (argv) => { probes.push([...argv]); await beforeProbe.run?.(); return probe.result },
  })
  f.ctx.workspaces = workspaces()
  f.api.on("GET /experimental/session?roots=true&limit=200", { status: 200, data: [] })
  const seed = (n: number, extra: Partial<HostSessionState> = {}) => {
    const state = { sessionKey: `s-${String(n).padStart(10, "0")}`, sessionID: `ses_${String(n).padStart(18, "0")}`, supervisor: f.ctx.supervisor, hostRepo: "C:\\GitHub\\demo", base: BASE, createdAt: new Date(n * 1000).toISOString(), ...extra }
    writeHostState(stateDir, state)
    return { state, file: path.join(stateDir, `${state.sessionKey}.json`) }
  }
  return { ...f, stateDir, workspaces, probe, probes, beforeProbe, seed, list: () => invoke(listSessionsTool, {}, f.ctx) }
}

describe("deleted session host records", () => {
  test("healthy listing plus direct 404 and proved absent clone removes only the host record", async () => {
    const f = fixture()
    const s = f.seed(1)
    expect((await f.list()).isError).toBeUndefined()
    expect(existsSync(s.file)).toBe(false)
    expect(f.probes).toHaveLength(1)
    expect(f.probes[0]?.slice(-2)).toEqual([`/sessions/${s.state.sessionKey}`, "/sessions"])
    expect(f.probes.some((args) => args.includes("rm"))).toBe(false)
  })

  test("oldest records beyond newest-200 and first-20 live reads are reached across restarts", async () => {
    const f = fixture()
    const old = f.seed(250, { createdAt: "1970-01-01T00:00:00.000Z" })
    for (let n = 0; n < 250; n++) {
      const s = f.seed(n)
      f.api.on(`GET /session/${s.state.sessionID}`, { status: 200, data: { id: s.state.sessionID } })
    }
    for (let i = 0; i < 14; i++) {
      f.ctx.workspaces = f.workspaces()
      f.api.calls.length = 0
      await f.list()
      expect(f.api.calls.filter((call) => call.path.startsWith("/session/")).length).toBeLessThanOrEqual(20)
    }
    expect(existsSync(old.file)).toBe(false)
  })

  test.each([
    ["clone survives", { code: 45, stdout: "", stderr: "" }],
    ["timeout despite absent exit", { code: 44, stdout: "", stderr: "", timedOut: true }],
    ["ambiguous test exit", { code: 1, stdout: "", stderr: "" }],
    ["daemon error", { code: 44, stdout: "", stderr: "daemon unavailable" }],
  ] as const)("keeps recovery data when %s", async (_label, result) => {
    const f = fixture()
    const s = f.seed(1)
    f.probe.result = result
    await f.list()
    expect(existsSync(s.file)).toBe(true)
  })

  test.each([200, 401, 500])("HTTP %i is not proof that the record is stale", async (status) => {
    const f = fixture()
    const s = f.seed(1)
    f.api.on(`GET /session/${s.state.sessionID}`, { status, data: { id: s.state.sessionID } })
    await f.list()
    expect(existsSync(s.file)).toBe(true)
    expect(f.probes).toHaveLength(0)
  })

  test("a failed list, unreadable record, or foreign record is never pruned", async () => {
    const f = fixture()
    const own = f.seed(1)
    const foreign = f.seed(2, { supervisor: "supervisor:other" })
    mkdirSync(path.join(f.stateDir, "bad-file.json"))
    writeFileSync(path.join(f.stateDir, "bad-data.json"), "bad json")
    f.api.on("GET /experimental/session?roots=true&limit=200", { status: 500 })
    expect((await f.list()).isError).toBe(true)
    expect(existsSync(own.file)).toBe(true)
    f.api.on("GET /experimental/session?roots=true&limit=200", { status: 200, data: [] })
    await f.list()
    expect(existsSync(foreign.file)).toBe(true)
    expect(readFileSync(path.join(f.stateDir, "bad-data.json"), "utf8")).toBe("bad json")
    expect(existsSync(path.join(f.stateDir, "bad-file.json"))).toBe(true)
  })

  test("record replaced during the box await is kept, including changes to an unknown field", async () => {
    const f = fixture()
    const s = f.seed(1)
    const updated = JSON.stringify({ ...s.state, futureField: "new-owner-state" })
    f.beforeProbe.run = () => writeFileSync(s.file, updated)
    await f.list()
    expect(readFileSync(s.file, "utf8")).toBe(updated)
  })

  test("host links are left intact; the target is never deleted", async () => {
    const f = fixture()
    const s = f.seed(1)
    const target = path.join(f.stateDir, "link-target")
    mkdirSync(target)
    writeFileSync(path.join(target, "keep.txt"), "keep")
    symlinkSync(target, path.join(f.stateDir, "linked-file.json"), process.platform === "win32" ? "junction" : "dir")
    await f.list()
    expect(existsSync(s.file)).toBe(false)
    expect(readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("keep")
    expect(existsSync(path.join(f.stateDir, "linked-file.json"))).toBe(true)
  })

  test("a full page of damaged records advances the persisted cursor", async () => {
    const f = fixture()
    const s = f.seed(1)
    for (let i = 0; i < 100; i++) writeFileSync(path.join(f.stateDir, `bad-${String(i).padStart(4, "0")}.json`), "invalid")
    await f.list()
    expect(existsSync(s.file)).toBe(true)
    f.ctx.workspaces = f.workspaces()
    await f.list()
    expect(existsSync(s.file)).toBe(false)
  })

  test("parallel lists share maintenance and a later replacement survives", async () => {
    const f = fixture()
    const s = f.seed(1)
    let release: (() => void) | undefined
    const wait = new Promise<void>((resolve) => { release = resolve })
    f.beforeProbe.run = () => wait
    const first = f.list()
    const second = f.list()
    for (let i = 0; i < 20 && f.probes.length === 0; i++) await Promise.resolve()
    const replacement = JSON.stringify({ ...s.state, base: "b".repeat(40) })
    writeFileSync(s.file, replacement)
    release?.()
    await Promise.all([first, second])
    expect(f.probes).toHaveLength(1)
    expect(readFileSync(s.file, "utf8")).toBe(replacement)
  })

  test("cached deleted session keeps its surviving clone and can still collect real commits", async () => {
    const ws = new WorkspaceFixture("ocd-prune-collect-")
    await ws.setup()
    try {
      const f = fakeContext()
      f.ctx.workspaces = ws.workspaces()
      const opened = await f.ctx.workspaces.open(ws.hostRepo, "collect-kept")
      const rec = record({ ...opened })
      await f.ctx.workspaces.bindSession(opened.sessionKey, { sessionID: rec.sessionID, supervisor: f.ctx.supervisor, profile: rec.profile })
      f.ctx.sessions.set(rec.sessionID, rec)
      f.api.on("GET /experimental/session?roots=true&limit=200", { status: 200, data: [] })
      await ws.boxCommit(opened.sessionKey, { "kept.txt": "saved work\n" }, "keep work")
      expect((await invoke(listSessionsTool, {}, f.ctx)).isError).toBeUndefined()
      expect(await f.ctx.workspaces.sessionState(opened.sessionKey)).toBeDefined()
      const result = await invoke(collectTool, { sessionID: rec.sessionID }, f.ctx)
      expect(result.isError).toBeUndefined()
      expect(result.structuredContent?.commits).toBe(1)
    } finally {
      ws.teardown()
    }
  }, T)
})
