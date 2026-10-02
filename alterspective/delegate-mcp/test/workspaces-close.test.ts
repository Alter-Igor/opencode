// #72: closing a finished session (box clone, OpenCode session, host record, optional host branch).
// Real git on scratch repos, simulated box (workspaces-fixture.ts). The data-loss guards are checked
// against both the result AND what is left on disk (AILES-056: a refusal must write nothing).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { defaultConfig } from "../src/shared/config.ts"
import type { CloseHooks, SessionRemoval } from "../src/supervisor/workspaces-close.ts"
import { writeHostState } from "../src/supervisor/workspaces-state.ts"
import { git, T, WorkspaceFixture } from "./workspaces-fixture.ts"

const fx = new WorkspaceFixture("ocd-wsclose-")
beforeAll(() => fx.setup(), T)
beforeEach(() => {
  fx.boxOverride = undefined
})
afterAll(() => fx.teardown())

const SUPERVISOR = "supervisor:test-bridge"
const KEEP = { discardWork: false, deleteBranch: false }
let serial = 0

/** A started, bound session of this bridge: clone in the box, record on the host. */
async function started() {
  serial++
  const key = `close-${String(serial).padStart(4, "0")}`
  const sessionID = `ses_${String(serial).padStart(18, "0")}`
  const ws = fx.workspaces()
  const opened = await ws.open(fx.hostRepo, key)
  await ws.bindSession(key, { sessionID, profile: "standard", supervisor: SUPERVISOR })
  const recordFile = path.join(fx.tmp, "state", `${key}.json`)
  const calls: string[] = []
  const hooks = (o: { result?: SessionRemoval; onStop?: () => Promise<void>; onDelete?: () => Promise<void> } = {}): CloseHooks => ({
    stop: async () => {
      calls.push("stop")
      await o.onStop?.()
    },
    deleteSession: async () => {
      calls.push("delete")
      await o.onDelete?.()
      return o.result ?? "deleted"
    },
  })
  return { key, sessionID, ws, opened, recordFile, calls, hooks, owner: { supervisor: SUPERVISOR, sessionID } }
}

const branchRef = (key: string) => `refs/heads/delegate/${key}`
const codeOf = (p: Promise<unknown>) => p.then(() => "resolved", (e: { code?: string }) => e.code ?? "unknown")

describe("closeSession: happy path", () => {
  test(
    "a collected session: stop, delete, clone and record removed; the host branch kept unless asked",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "a.txt": "one\n" }, "one")
      await s.ws.collect(s.opened)
      const out = await s.ws.closeSession(s.key, s.owner, KEEP, s.hooks())
      expect(out).toMatchObject({ closed: true, session: "deleted", clone: "removed", record: "removed", branch: "not_requested", uncollectedCommits: 0, uncommittedPaths: 0 })
      expect(s.calls).toEqual(["stop", "delete"])
      expect(fx.leftovers(s.key)).toEqual([])
      expect(existsSync(s.recordFile)).toBe(false)
      expect(await fx.hostHas(branchRef(s.key))).toBe(true)
    },
    T,
  )

  test(
    "cycle 2: ignored dependency/cache folders do not block; the bridge's own scratch is not counted",
    async () => {
      const s = await started()
      appendFileSync(path.join(fx.boxClone(s.key), ".git", "info", "exclude"), "node_modules/\n")
      mkdirSync(path.join(fx.boxClone(s.key), "node_modules", "x"), { recursive: true })
      writeFileSync(path.join(fx.boxClone(s.key), "node_modules", "x", "index.js"), "x\n")
      mkdirSync(path.join(fx.boxClone(s.key), ".system_generated"), { recursive: true })
      writeFileSync(path.join(fx.boxClone(s.key), ".system_generated", "obs.json"), "{}\n")
      const out = await s.ws.closeSession(s.key, s.owner, KEEP, s.hooks())
      expect(out).toMatchObject({ closed: true, ignoredPaths: 0, uncommittedPaths: 0 })
    },
    T,
  )

  test(
    "cycle 2: other git-ignored files (dist/out.js, .env) block unless discardWork, with up to 10 example paths",
    async () => {
      const s = await started()
      appendFileSync(path.join(fx.boxClone(s.key), ".git", "info", "exclude"), "dist/\n.env\n")
      mkdirSync(path.join(fx.boxClone(s.key), "dist"), { recursive: true })
      writeFileSync(path.join(fx.boxClone(s.key), "dist", "out.js"), "x\n")
      writeFileSync(path.join(fx.boxClone(s.key), ".env"), "A=1\n")
      const out = await s.ws.closeSession(s.key, s.owner, KEEP, s.hooks())
      expect(out).toMatchObject({ closed: false, refused: "ignored_files", session: "kept", clone: "kept", record: "kept", ignoredPaths: 2 })
      expect([...out.ignoredExamples].sort()).toEqual([".env", "dist/"])
      expect(s.calls).toEqual([])
      const discarded = await s.ws.closeSession(s.key, s.owner, { discardWork: true, deleteBranch: false }, s.hooks())
      expect(discarded).toMatchObject({ closed: true, ignoredPaths: 2 })
    },
    T,
  )

  test(
    "cycle 2: a commit replaced by --amend is reported as discarded and does not block after collect",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "a.txt": "one\n" }, "first try")
      await fx.boxGit(s.key, ["commit", "-q", "--amend", "-m", "amended"])
      await s.ws.collect(s.opened)
      const out = await s.ws.closeSession(s.key, s.owner, KEEP, s.hooks())
      expect(out).toMatchObject({ closed: true, uncollectedCommits: 0, discardedCommits: 1 })
    },
    T,
  )
})

describe("closeSession: data-loss guards", () => {
  test(
    "uncollected commits are refused with the count before stop, and nothing is touched",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "a.txt": "one\n" }, "one")
      await fx.boxCommit(s.key, { "b.txt": "two\n" }, "two")
      const before = readFileSync(s.recordFile, "utf8")
      const out = await s.ws.closeSession(s.key, s.owner, { discardWork: false, deleteBranch: true }, s.hooks())
      expect(out).toMatchObject({ closed: false, refused: "uncollected_work", uncollectedCommits: 2, session: "kept", clone: "kept", record: "kept" })
      expect(s.calls).toEqual([])
      expect(fx.leftovers(s.key)).toEqual([s.key])
      expect(readFileSync(s.recordFile, "utf8")).toBe(before)
    },
    T,
  )

  test(
    "HIGH 2: work that appears while stopping is refused BEFORE the session is deleted",
    async () => {
      const s = await started()
      const out = await s.ws.closeSession(s.key, s.owner, KEEP, s.hooks({ onStop: () => fx.boxCommit(s.key, { "late.txt": "late\n" }, "late") }))
      expect(out).toMatchObject({ closed: false, refused: "uncollected_work", session: "kept", clone: "kept", record: "kept", uncollectedCommits: 1 })
      expect(s.calls).toEqual(["stop"])
      expect(fx.leftovers(s.key)).toEqual([s.key])
    },
    T,
  )

  test(
    "work that slips in while the session is deleted keeps the clone and the record",
    async () => {
      const s = await started()
      const out = await s.ws.closeSession(s.key, s.owner, KEEP, s.hooks({ onDelete: () => fx.boxCommit(s.key, { "race.txt": "race\n" }, "race") }))
      expect(out).toMatchObject({ closed: false, refused: "uncollected_work", session: "deleted", clone: "kept", record: "kept", uncollectedCommits: 1 })
      expect(fx.leftovers(s.key)).toEqual([s.key])
      expect(existsSync(s.recordFile)).toBe(true)
    },
    T,
  )

  test(
    "a partial collect counts only the commits the host does not have",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "a.txt": "one\n" }, "one")
      await s.ws.collect(s.opened)
      await fx.boxCommit(s.key, { "b.txt": "two\n" }, "two")
      const out = await s.ws.closeSession(s.key, s.owner, KEEP, s.hooks())
      expect(out).toMatchObject({ closed: false, refused: "uncollected_work", uncollectedCommits: 1 })
    },
    T,
  )

  test(
    "commits on another box branch and uncommitted files are uncollected work; reflog-only commits are only reported",
    async () => {
      const s = await started()
      await fx.boxGit(s.key, ["checkout", "-q", "-b", "side"])
      await fx.boxCommit(s.key, { "side.txt": "x\n" }, "side")
      await fx.boxGit(s.key, ["checkout", "-q", `delegate/${s.key}`])
      await fx.boxCommit(s.key, { "gone.txt": "y\n" }, "reset away")
      await fx.boxGit(s.key, ["reset", "-q", "--hard", "HEAD~1"])
      writeFileSync(path.join(fx.boxClone(s.key), "loose.txt"), "not committed\n")
      const out = await s.ws.closeSession(s.key, s.owner, KEEP, s.hooks())
      expect(out).toMatchObject({ closed: false, refused: "uncollected_work", uncollectedCommits: 1, discardedCommits: 1, uncommittedPaths: 1 })
      expect(s.calls).toEqual([])
    },
    T,
  )

  test(
    "discardWork deletes uncollected work and reports the counts found after stopping",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "a.txt": "one\n" }, "one")
      const out = await s.ws.closeSession(s.key, s.owner, { discardWork: true, deleteBranch: false }, s.hooks({ onStop: () => fx.boxCommit(s.key, { "b.txt": "two\n" }, "two") }))
      expect(out).toMatchObject({ closed: true, clone: "removed", record: "removed", uncollectedCommits: 2 })
      expect(fx.leftovers(s.key)).toEqual([])
    },
    T,
  )

  test(
    "a box that cannot be read is check_failed and nothing is touched",
    async () => {
      const s = await started()
      fx.boxOverride = (argv) => (argv[0] === "sh" ? { code: 125, stdout: "", stderr: "Error response from daemon: container is not running" } : undefined)
      const out = await s.ws.closeSession(s.key, s.owner, KEEP, s.hooks())
      expect(out).toMatchObject({ closed: false, refused: "check_failed", session: "kept", clone: "kept", record: "kept" })
      expect(s.calls).toEqual([])
      expect(existsSync(s.recordFile)).toBe(true)
    },
    T,
  )

  test(
    "inspectClose reports the same counts and writes nothing",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "a.txt": "one\n" }, "one")
      const plan = await s.ws.inspectClose(s.key, s.owner, { deleteBranch: false })
      expect(plan).toMatchObject({ clone: "present", safe: false, reason: "uncollected_work", uncollectedCommits: 1 })
      expect(fx.leftovers(s.key)).toEqual([s.key])
      expect(existsSync(s.recordFile)).toBe(true)
    },
    T,
  )
})

describe("closeSession: the host branch", () => {
  test(
    "deleteBranch removes delegate/<key> when another host branch contains it; other branches are untouched",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "m.txt": "merged\n" }, "merged")
      await s.ws.collect(s.opened)
      await git(fx.hostRepo, ["branch", "feature-keep"])
      await git(fx.hostRepo, ["merge", "-q", "--ff-only", `delegate/${s.key}`])
      const out = await s.ws.closeSession(s.key, s.owner, { discardWork: false, deleteBranch: true }, s.hooks())
      expect(out).toMatchObject({ closed: true, branch: "deleted" })
      expect(await fx.hostHas(branchRef(s.key))).toBe(false)
      expect(await fx.hostHas("refs/heads/feature-keep")).toBe(true)
      expect(await fx.hostHas("refs/heads/main")).toBe(true)
      await git(fx.hostRepo, ["reset", "-q", "--hard", "HEAD~1"])
    },
    T,
  )

  test(
    "HIGH 1: a detached host HEAD at the branch tip is not 'merged': the branch is kept",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "d.txt": "detached\n" }, "detached")
      await s.ws.collect(s.opened)
      await git(fx.hostRepo, ["checkout", "-q", "--detach", `delegate/${s.key}`])
      try {
        const out = await s.ws.closeSession(s.key, s.owner, { discardWork: false, deleteBranch: true }, s.hooks())
        expect(out).toMatchObject({ closed: true, branch: "kept_unmerged" })
        expect(await fx.hostHas(branchRef(s.key))).toBe(true)
      } finally {
        await git(fx.hostRepo, ["checkout", "-q", "main"])
      }
    },
    T,
  )

  test(
    "an unmerged branch is kept (the rest still closes); discardWork deletes it",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "u.txt": "unmerged\n" }, "unmerged")
      await s.ws.collect(s.opened)
      const out = await s.ws.closeSession(s.key, s.owner, { discardWork: false, deleteBranch: true }, s.hooks())
      expect(out).toMatchObject({ closed: true, branch: "kept_unmerged", record: "removed" })
      expect(await fx.hostHas(branchRef(s.key))).toBe(true)

      const t = await started()
      await fx.boxCommit(t.key, { "v.txt": "unmerged\n" }, "unmerged")
      await t.ws.collect(t.opened)
      const discarded = await t.ws.closeSession(t.key, t.owner, { discardWork: true, deleteBranch: true }, t.hooks())
      expect(discarded).toMatchObject({ closed: true, branch: "deleted" })
      expect(await fx.hostHas(branchRef(t.key))).toBe(false)
    },
    T,
  )

  test(
    "MEDIUM 3: a symbolic delegate/<key> pointing at main is never followed or deleted",
    async () => {
      const s = await started()
      await git(fx.hostRepo, ["symbolic-ref", branchRef(s.key), "refs/heads/main"])
      try {
        const out = await s.ws.closeSession(s.key, s.owner, { discardWork: true, deleteBranch: true }, s.hooks())
        expect(out).toMatchObject({ closed: true, branch: "kept_symbolic" })
        expect(await fx.hostHas("refs/heads/main")).toBe(true)
      } finally {
        await git(fx.hostRepo, ["update-ref", "--no-deref", "-d", branchRef(s.key)])
      }
      expect(await fx.hostHas("refs/heads/main")).toBe(true)
    },
    T,
  )

  test(
    "a branch checked out on the host is never deleted, even with discardWork",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "c.txt": "co\n" }, "co")
      await s.ws.collect(s.opened)
      const worktree = path.join(fx.tmp, `wt-${s.key}`)
      await git(fx.hostRepo, ["worktree", "add", "-q", worktree, `delegate/${s.key}`])
      try {
        const out = await s.ws.closeSession(s.key, s.owner, { discardWork: true, deleteBranch: true }, s.hooks())
        expect(out).toMatchObject({ closed: true, branch: "kept_checked_out" })
        expect(await fx.hostHas(branchRef(s.key))).toBe(true)
      } finally {
        await git(fx.hostRepo, ["worktree", "remove", "--force", worktree])
      }
    },
    T,
  )
})

describe("closeSession: ownership and recovery", () => {
  test(
    "another bridge's record, another box's record and a legacy record are refused untouched",
    async () => {
      const s = await started()
      const all = { discardWork: true, deleteBranch: true }
      expect(await codeOf(s.ws.closeSession(s.key, { supervisor: "supervisor:other-bridge", sessionID: s.sessionID }, all, s.hooks()))).toBe("not_found")
      expect(await codeOf(s.ws.closeSession(s.key, { supervisor: SUPERVISOR, sessionID: "ses_999999999999999999" }, all, s.hooks()))).toBe("not_found")
      const record = JSON.parse(readFileSync(s.recordFile, "utf8"))
      writeHostState(path.join(fx.tmp, "state"), { ...record, boxProject: "another-box" })
      expect(await codeOf(s.ws.closeSession(s.key, s.owner, all, s.hooks()))).toBe("not_found")
      const { boxProject: _legacy, ...legacy } = record
      writeFileSync(s.recordFile, JSON.stringify(legacy))
      expect(await codeOf(s.ws.closeSession(s.key, s.owner, all, s.hooks()))).toBe("not_found")
      expect(s.calls).toEqual([])
      expect(fx.leftovers(s.key)).toEqual([s.key])
      expect(existsSync(s.recordFile)).toBe(true)
    },
    T,
  )

  test(
    "a failed stop or a failed session delete keeps the clone and the record",
    async () => {
      const s = await started()
      const boom = async () => {
        throw new Error("HTTP 500")
      }
      expect(await codeOf(s.ws.closeSession(s.key, s.owner, KEEP, s.hooks({ onStop: boom })))).toBe("upstream_error")
      expect(await codeOf(s.ws.closeSession(s.key, s.owner, KEEP, s.hooks({ onDelete: boom })))).toBe("upstream_error")
      expect(fx.leftovers(s.key)).toEqual([s.key])
      expect(existsSync(s.recordFile)).toBe(true)
    },
    T,
  )

  test(
    "a failed clone removal keeps the record; a retry after the session is gone finishes the job",
    async () => {
      const s = await started()
      fx.boxOverride = (argv) => (argv[0] === "rm" ? { code: 1, stdout: "", stderr: "rm: cannot remove: Device or resource busy" } : undefined)
      const first = await s.ws.closeSession(s.key, s.owner, KEEP, s.hooks())
      expect(first).toMatchObject({ closed: false, session: "deleted", clone: "failed", record: "kept" })
      expect(existsSync(s.recordFile)).toBe(true)
      fx.boxOverride = undefined
      const retry = await s.ws.closeSession(s.key, s.owner, KEEP, s.hooks({ result: "already_gone" }))
      expect(retry).toMatchObject({ closed: true, session: "already_gone", clone: "removed", record: "removed" })
    },
    T,
  )

  test(
    "a record whose clone is already gone is removed",
    async () => {
      const s = await started()
      await fx.boxExec(["rm", "-rf", "--", `/sessions/${s.key}`])
      const out = await s.ws.closeSession(s.key, s.owner, KEEP, s.hooks({ result: "already_gone" }))
      expect(out).toMatchObject({ closed: true, clone: "absent", record: "removed" })
    },
    T,
  )
})

describe("closeCandidates", () => {
  const project = defaultConfig({}).project
  async function seeded(dir: string, n: number, extra: (i: number) => Record<string, unknown> = () => ({})) {
    const base = (await git(fx.hostRepo, ["rev-parse", "HEAD"])).trim()
    for (let i = 1; i <= n; i++)
      writeHostState(dir, { sessionKey: `cand-${String(i).padStart(3, "0")}`, hostRepo: fx.hostRepo, base, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), sessionID: `ses_${String(i).padStart(18, "7")}`, supervisor: SUPERVISOR, boxProject: project, ...extra(i) })
  }

  test(
    "only this bridge's bound records of this box created before the cutoff; the others are counted",
    async () => {
      const dir = path.join(fx.tmp, "cand-a")
      await seeded(dir, 6, (i) => (i === 2 ? { supervisor: "supervisor:other-bridge" } : i === 4 ? { boxProject: "another-box" } : i === 5 ? { boxProject: undefined } : i === 6 ? { createdAt: new Date().toISOString() } : {}))
      const out = await fx.workspaces({ stateDir: dir }).closeCandidates(SUPERVISOR, new Date(Date.UTC(2026, 0, 10)), 10)
      expect(out.states.map((s) => s.sessionKey)).toEqual(["cand-001", "cand-003"])
      expect(out).toMatchObject({ legacy: 1, otherBox: 1, otherBridge: 1 })
    },
    T,
  )

  test(
    "MEDIUM 6: a persisted cursor moves past kept records, so later records are reached",
    async () => {
      const dir = path.join(fx.tmp, "cand-b")
      await seeded(dir, 25)
      const cutoff = new Date(Date.UTC(2026, 0, 10))
      const preview = await fx.workspaces({ stateDir: dir }).closeCandidates(SUPERVISOR, cutoff, 20, { moveCursor: false })
      const first = await fx.workspaces({ stateDir: dir }).closeCandidates(SUPERVISOR, cutoff, 20)
      const second = await fx.workspaces({ stateDir: dir }).closeCandidates(SUPERVISOR, cutoff, 20)
      // cycle 2: a dry run (moveCursor: false) sees exactly what the real run then sees.
      expect(preview.states.map((s) => s.sessionKey)).toEqual(first.states.map((s) => s.sessionKey))
      expect(first.states.map((s) => s.sessionKey)[0]).toBe("cand-001")
      expect(first.states).toHaveLength(20)
      expect(second.states.map((s) => s.sessionKey).slice(0, 5)).toEqual(["cand-021", "cand-022", "cand-023", "cand-024", "cand-025"])
    },
    T,
  )
})
