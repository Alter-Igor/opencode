// #72: closing a finished session (box clone, OpenCode session, host record, optional host branch).
// Real git on scratch repos, simulated box (workspaces-fixture.ts). The data-loss guards are checked
// against both the result AND what is left on disk (AILES-056: a refusal must write nothing).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { defaultConfig } from "../src/shared/config.ts"
import type { SessionRemoval } from "../src/supervisor/workspaces-close.ts"
import { writeHostState } from "../src/supervisor/workspaces-state.ts"
import { git, T, WorkspaceFixture } from "./workspaces-fixture.ts"

const fx = new WorkspaceFixture("ocd-wsclose-")
beforeAll(() => fx.setup(), T)
beforeEach(() => {
  fx.boxOverride = undefined
})
afterAll(() => fx.teardown())

const SUPERVISOR = "supervisor:test-bridge"
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
  const deleter = (result: SessionRemoval = "deleted") => async () => {
    calls.push("delete")
    return result
  }
  return { key, sessionID, ws, opened, recordFile, calls, deleter, owner: { supervisor: SUPERVISOR, sessionID } }
}

const branchRef = (key: string) => `refs/heads/delegate/${key}`

describe("closeSession: happy path", () => {
  test(
    "a collected session: session, clone and record are removed; the host branch is kept unless asked",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "a.txt": "one\n" }, "one")
      await s.ws.collect(s.opened)
      const out = await s.ws.closeSession(s.key, s.owner, { force: false, deleteBranch: false }, s.deleter())
      expect(out).toMatchObject({ closed: true, session: "deleted", clone: "removed", record: "removed", branch: "not_requested", uncollectedCommits: 0, uncommittedPaths: 0 })
      expect(s.calls).toEqual(["delete"])
      expect(fx.leftovers(s.key)).toEqual([])
      expect(existsSync(s.recordFile)).toBe(false)
      expect(await fx.hostHas(branchRef(s.key))).toBe(true)
    },
    T,
  )

  test(
    "a session with no commits at all closes without collect",
    async () => {
      const s = await started()
      const out = await s.ws.closeSession(s.key, s.owner, { force: false, deleteBranch: false }, s.deleter())
      expect(out).toMatchObject({ closed: true, clone: "removed", record: "removed" })
    },
    T,
  )
})

describe("closeSession: data-loss guards", () => {
  test(
    "uncollected commits are refused with the count, and nothing is touched",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "a.txt": "one\n" }, "one")
      await fx.boxCommit(s.key, { "b.txt": "two\n" }, "two")
      const before = readFileSync(s.recordFile, "utf8")
      const out = await s.ws.closeSession(s.key, s.owner, { force: false, deleteBranch: true }, s.deleter())
      expect(out).toMatchObject({ closed: false, refused: "uncollected_work", uncollectedCommits: 2, session: "kept", clone: "kept", record: "kept" })
      expect(s.calls).toEqual([])
      expect(fx.leftovers(s.key)).toEqual([s.key])
      expect(readFileSync(s.recordFile, "utf8")).toBe(before)
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
      const out = await s.ws.closeSession(s.key, s.owner, { force: false, deleteBranch: false }, s.deleter())
      expect(out).toMatchObject({ closed: false, refused: "uncollected_work", uncollectedCommits: 1 })
    },
    T,
  )

  test(
    "commits on another box branch, and uncommitted files, are also uncollected work",
    async () => {
      const s = await started()
      await fx.boxGit(s.key, ["checkout", "-q", "-b", "side"])
      await fx.boxCommit(s.key, { "side.txt": "x\n" }, "side")
      await fx.boxGit(s.key, ["checkout", "-q", `delegate/${s.key}`])
      writeFileSync(path.join(fx.boxClone(s.key), "loose.txt"), "not committed\n")
      const out = await s.ws.closeSession(s.key, s.owner, { force: false, deleteBranch: false }, s.deleter())
      expect(out).toMatchObject({ closed: false, refused: "uncollected_work", uncollectedCommits: 1, uncommittedPaths: 1 })
      expect(s.calls).toEqual([])
    },
    T,
  )

  test(
    "force: true deletes uncollected work and says how much was lost",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "a.txt": "one\n" }, "one")
      const out = await s.ws.closeSession(s.key, s.owner, { force: true, deleteBranch: false }, s.deleter())
      expect(out).toMatchObject({ closed: true, clone: "removed", record: "removed", uncollectedCommits: 1 })
      expect(fx.leftovers(s.key)).toEqual([])
    },
    T,
  )

  test(
    "a box that cannot be read is check_failed and nothing is touched",
    async () => {
      const s = await started()
      fx.boxOverride = (argv) => (argv[0] === "sh" ? { code: 125, stdout: "", stderr: "Error response from daemon: container is not running" } : undefined)
      const out = await s.ws.closeSession(s.key, s.owner, { force: false, deleteBranch: false }, s.deleter())
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
    "deleteBranch removes delegate/<key> only when it is merged into HEAD; other branches are untouched",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "m.txt": "merged\n" }, "merged")
      await s.ws.collect(s.opened)
      await git(fx.hostRepo, ["branch", "feature-keep"])
      await git(fx.hostRepo, ["merge", "-q", "--ff-only", `delegate/${s.key}`])
      const out = await s.ws.closeSession(s.key, s.owner, { force: false, deleteBranch: true }, s.deleter())
      expect(out).toMatchObject({ closed: true, branch: "deleted" })
      expect(await fx.hostHas(branchRef(s.key))).toBe(false)
      expect(await fx.hostHas("refs/heads/feature-keep")).toBe(true)
      expect(await fx.hostHas("refs/heads/main")).toBe(true)
      await git(fx.hostRepo, ["reset", "-q", "--hard", "HEAD~1"])
    },
    T,
  )

  test(
    "an unmerged branch is kept (the rest still closes); force deletes it",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "u.txt": "unmerged\n" }, "unmerged")
      await s.ws.collect(s.opened)
      const out = await s.ws.closeSession(s.key, s.owner, { force: false, deleteBranch: true }, s.deleter())
      expect(out).toMatchObject({ closed: true, branch: "kept_unmerged", record: "removed" })
      expect(await fx.hostHas(branchRef(s.key))).toBe(true)

      const t = await started()
      await fx.boxCommit(t.key, { "v.txt": "unmerged\n" }, "unmerged")
      await t.ws.collect(t.opened)
      const forced = await t.ws.closeSession(t.key, t.owner, { force: true, deleteBranch: true }, t.deleter())
      expect(forced).toMatchObject({ closed: true, branch: "deleted" })
      expect(await fx.hostHas(branchRef(t.key))).toBe(false)
    },
    T,
  )

  test(
    "a branch checked out on the host is never deleted, even with force",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "c.txt": "co\n" }, "co")
      await s.ws.collect(s.opened)
      const worktree = path.join(fx.tmp, `wt-${s.key}`)
      await git(fx.hostRepo, ["worktree", "add", "-q", worktree, `delegate/${s.key}`])
      try {
        const out = await s.ws.closeSession(s.key, s.owner, { force: true, deleteBranch: true }, s.deleter())
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
      const other = await s.ws.closeSession(s.key, { supervisor: "supervisor:other-bridge", sessionID: s.sessionID }, { force: true, deleteBranch: true }, s.deleter()).catch((e: { code: string }) => e.code)
      expect(other).toBe("not_found")
      const wrongId = await s.ws.closeSession(s.key, { supervisor: SUPERVISOR, sessionID: "ses_999999999999999999" }, { force: true, deleteBranch: true }, s.deleter()).catch((e: { code: string }) => e.code)
      expect(wrongId).toBe("not_found")
      const record = JSON.parse(readFileSync(s.recordFile, "utf8"))
      writeHostState(path.join(fx.tmp, "state"), { ...record, boxProject: "another-box" })
      expect(await s.ws.closeSession(s.key, s.owner, { force: true, deleteBranch: true }, s.deleter()).catch((e: { code: string }) => e.code)).toBe("not_found")
      const { boxProject: _legacy, ...legacy } = record
      writeFileSync(s.recordFile, JSON.stringify(legacy))
      expect(await s.ws.closeSession(s.key, s.owner, { force: true, deleteBranch: true }, s.deleter()).catch((e: { code: string }) => e.code)).toBe("not_found")
      expect(s.calls).toEqual([])
      expect(fx.leftovers(s.key)).toEqual([s.key])
      expect(existsSync(s.recordFile)).toBe(true)
    },
    T,
  )

  test(
    "a failed session delete keeps the clone and the record",
    async () => {
      const s = await started()
      const out = await s.ws
        .closeSession(s.key, s.owner, { force: false, deleteBranch: false }, async () => {
          throw new Error("HTTP 500")
        })
        .catch((e: { code: string }) => e.code)
      expect(out).toBe("upstream_error")
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
      const first = await s.ws.closeSession(s.key, s.owner, { force: false, deleteBranch: false }, s.deleter())
      expect(first).toMatchObject({ closed: false, session: "deleted", clone: "failed", record: "kept" })
      expect(existsSync(s.recordFile)).toBe(true)
      fx.boxOverride = undefined
      const retry = await s.ws.closeSession(s.key, s.owner, { force: false, deleteBranch: false }, s.deleter("already_gone"))
      expect(retry).toMatchObject({ closed: true, session: "already_gone", clone: "removed", record: "removed" })
    },
    T,
  )

  test(
    "a record whose clone is already gone is removed",
    async () => {
      const s = await started()
      await fx.boxCommit(s.key, { "a.txt": "lost before\n" }, "one")
      fx.boxOverride = undefined
      await fx.boxExec(["rm", "-rf", "--", `/sessions/${s.key}`])
      const out = await s.ws.closeSession(s.key, s.owner, { force: false, deleteBranch: false }, s.deleter("already_gone"))
      expect(out).toMatchObject({ closed: true, clone: "absent", record: "removed" })
    },
    T,
  )
})

describe("closeCandidates", () => {
  test(
    "lists only this bridge's bound records of this box created before the cutoff, oldest first, and counts the rest",
    async () => {
      const dir = path.join(fx.tmp, "cand-state")
      const sweepWs = fx.workspaces({ stateDir: dir })
      const base = (await git(fx.hostRepo, ["rev-parse", "HEAD"])).trim()
      const project = defaultConfig({}).project
      const mk = (n: number, extra: Record<string, unknown>) =>
        writeHostState(dir, { sessionKey: `cand-${n}`, hostRepo: fx.hostRepo, base, createdAt: new Date(Date.UTC(2026, 0, n)).toISOString(), sessionID: `ses_${String(n).padStart(18, "7")}`, supervisor: SUPERVISOR, boxProject: project, ...extra })
      mk(3, {})
      mk(1, {})
      mk(2, { supervisor: "supervisor:other-bridge" })
      mk(4, { boxProject: "another-box" })
      mk(5, { boxProject: undefined })
      mk(20, {})
      const out = await sweepWs.closeCandidates(SUPERVISOR, new Date(Date.UTC(2026, 0, 10)), 10)
      expect(out.states.map((s) => s.sessionKey)).toEqual(["cand-1", "cand-3"])
      expect(out.legacy).toBe(1)
      expect(out.otherBox).toBe(1)
    },
    T,
  )
})
