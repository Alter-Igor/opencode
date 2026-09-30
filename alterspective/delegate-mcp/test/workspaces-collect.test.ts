// Workspaces, part 2: hand-off hardening (C-4), specific collect errors (A-22), deadlines (A-14) and
// folder validation. Fixture (real git, simulated box): workspaces-fixture.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { canonicalPath, runCommand, type Exec } from "../src/supervisor/workspaces.ts"
import { removeEntry } from "../src/supervisor/workspaces-handoff.ts"
import { code, failure, git, OK, plantLink, T, WorkspaceFixture } from "./workspaces-fixture.ts"

const fx = new WorkspaceFixture("ocd-wsc-")
beforeAll(() => fx.setup(), T)
beforeEach(() => {
  fx.boxOverride = undefined
})
afterAll(() => fx.teardown())

describe("workspaces: hand-off hardening (C-4)", () => {
  const fixedNonce = () => "feedfacefeedface"

  test(
    "a link planted at the in-bundle path is removed, never followed",
    async () => {
      const victimDir = path.join(fx.tmp, "victim")
      mkdirSync(victimDir, { recursive: true })
      writeFileSync(path.join(victimDir, "victim.txt"), "keep me\n")
      mkdirSync(path.join(fx.handoff, "in"), { recursive: true })
      plantLink(path.join(victimDir, "victim.txt"), path.join(fx.handoff, "in", "plant-key-feedfacefeedface-in.bundle"))
      await fx.workspaces({ nonce: fixedNonce }).open(fx.hostRepo, "plant-key")
      expect(readdirSync(victimDir)).toEqual(["victim.txt"])
      expect(readFileSync(path.join(victimDir, "victim.txt"), "utf8")).toBe("keep me\n")
      expect(fx.handoffFiles()).toEqual([])
    },
    T,
  )

  test("a real directory at the in-bundle path, or a linked in/ folder, is refused", async () => {
    mkdirSync(path.join(fx.handoff, "in", "dir-key-feedfacefeedface-in.bundle"), { recursive: true })
    expect(await code(fx.workspaces({ nonce: fixedNonce }).open(fx.hostRepo, "dir-key"))).toBe("policy_violation")
    rmSync(path.join(fx.handoff, "in"), { recursive: true, force: true })
    plantLink(fx.tmp, path.join(fx.handoff, "in"))
    try {
      expect(await code(fx.workspaces().open(fx.hostRepo, "linked-in"))).toBe("policy_violation")
    } finally {
      removeEntry(path.join(fx.handoff, "in")) // the link only, never its target
    }
    expect(fx.leftovers("dir-key")).toEqual([])
    expect(fx.leftovers("linked-in")).toEqual([])
  })

  test(
    "an out-bundle over the size cap is bundle_too_large and nothing is fetched",
    async () => {
      const ws = await fx.workspaces().open(fx.hostRepo, "big-key")
      await fx.boxCommit("big-key", { "big.txt": randomBytes(4096).toString("hex") }, "big")
      expect(await code(fx.workspaces({ maxBundleBytes: 100 }).collect(ws))).toBe("bundle_too_large")
      expect(await fx.hostHas("delegate/big-key")).toBe(false)
      expect(fx.handoffFiles()).toEqual([])
      expect(fx.incoming()).toEqual([])
    },
    T,
  )

  test(
    "an out-bundle that is a link, a folder, or missing is refused before any fetch",
    async () => {
      const ws = await fx.workspaces().open(fx.hostRepo, "odd-key")
      await fx.boxCommit("odd-key", { "a.txt": "a\n" }, "work")
      const real = path.join(fx.tmp, "elsewhere.bundle")
      await fx.boxGit("odd-key", ["bundle", "create", "--quiet", real, "delegate/odd-key"])
      const writer = (make: (out: string) => void) => (argv: string[]) => {
        if (!argv.includes("bundle")) return undefined
        make(argv.at(-2) ?? "")
        return OK
      }
      fx.boxOverride = writer((out) => plantLink(real, out))
      expect(await code(fx.workspaces().collect(ws))).toBe("policy_violation")
      fx.boxOverride = writer((out) => mkdirSync(out))
      expect(await code(fx.workspaces().collect(ws))).toBe("policy_violation")
      fx.boxOverride = writer(() => {})
      expect(await code(fx.workspaces().collect(ws))).toBe("upstream_error")
      expect(await fx.hostHas("delegate/odd-key")).toBe(false)
      rmSync(path.join(fx.handoff, "out"), { recursive: true, force: true }) // the planted folder (links were removed)
    },
    T,
  )
})

describe("workspaces: collect errors are specific", () => {
  test(
    "a non-fast-forward session branch is branch_diverged and the host branch is untouched",
    async () => {
      const workspaces = fx.workspaces()
      const ws = await workspaces.open(fx.hostRepo, "nff-key")
      await fx.boxCommit("nff-key", { "a.txt": "1\n" }, "one")
      await workspaces.collect(ws)
      const before = await git(fx.hostRepo, ["rev-parse", "delegate/nff-key"])
      await fx.boxGit("nff-key", ["commit", "-q", "--amend", "-m", "rewritten"])
      const error = await failure(workspaces.collect(ws))
      expect(error.code).toBe("branch_diverged")
      expect(error.message).toContain("not a fast-forward")
      expect(await git(fx.hostRepo, ["rev-parse", "delegate/nff-key"])).toBe(before)
    },
    T,
  )

  test(
    "collecting into a branch the owner has checked out is directory_busy",
    async () => {
      const workspaces = fx.workspaces()
      const ws = await workspaces.open(fx.hostRepo, "co-key")
      await fx.boxCommit("co-key", { "a.txt": "1\n" }, "one")
      await workspaces.collect(ws)
      await fx.boxCommit("co-key", { "b.txt": "2\n" }, "two")
      await git(fx.hostRepo, ["checkout", "-q", "delegate/co-key"])
      try {
        expect(await code(workspaces.collect(ws))).toBe("directory_busy")
      } finally {
        await git(fx.hostRepo, ["checkout", "-q", "main"])
      }
    },
    T,
  )

  test("a missing record and a damaged record are told apart", async () => {
    const ws = (key: string) => ({ sessionKey: key, hostRepo: fx.hostRepo, boxPath: `/sessions/${key}`, branch: `delegate/${key}` })
    const missing = await failure(fx.workspaces().collect(ws("never-opened")))
    mkdirSync(path.join(fx.tmp, "state"), { recursive: true })
    writeFileSync(path.join(fx.tmp, "state", "corrupt-key.json"), "{not json")
    writeFileSync(path.join(fx.tmp, "state", "badbase-key.json"), JSON.stringify({ hostRepo: fx.hostRepo, base: "abc" }))
    const corrupt = await failure(fx.workspaces().collect(ws("corrupt-key")))
    const badBase = await failure(fx.workspaces().collect(ws("badbase-key")))
    expect([missing.code, corrupt.code, badBase.code]).toEqual(["not_found", "not_found", "not_found"])
    expect([missing.detail, corrupt.detail, badBase.detail]).toEqual(["missing", "corrupt", "corrupt"])
    expect(corrupt.message).not.toBe(missing.message)
    expect(corrupt.action).toContain("corrupt-key.json")
  })
})

describe("workspaces: deadlines and folder validation", () => {
  test(
    "whole-repo steps get the long deadline, small git calls the short one; a timeout says so",
    async () => {
      const seen: Array<[string, number | undefined]> = []
      const hostExec: Exec = (argv, options) => {
        seen.push([argv.slice(3, 5).join(" "), options?.timeoutMs])
        return runCommand(argv, undefined, options?.timeoutMs)
      }
      await fx.workspaces({ hostExec, timeouts: { longMs: 111_000, shortMs: 22_000 } }).open(fx.hostRepo, "time-key")
      expect(seen.find(([a]) => a.startsWith("bundle"))?.[1]).toBe(111_000)
      expect(seen.find(([a]) => a.startsWith("rev-parse --verify"))?.[1]).toBe(22_000)
      const slow: Exec = (argv, options) =>
        argv.includes("bundle") ? Promise.resolve({ code: 124, stdout: "", stderr: "timed out", timedOut: true }) : runCommand(argv, undefined, options?.timeoutMs)
      const error = await failure(fx.workspaces({ hostExec: slow }).open(fx.hostRepo, "slow-key"))
      expect([error.code, error.detail]).toEqual(["upstream_error", "timeout"])
      expect(fx.leftovers("slow-key")).toEqual([])
      expect(fx.handoffFiles()).toEqual([])
    },
    T,
  )

  test(
    "refuses folders outside the roots, '..' escapes, and non-repos; the action names the roots",
    async () => {
      const outside = path.join(fx.tmp, "outside")
      mkdirSync(outside, { recursive: true })
      await git(outside, ["init", "-q"])
      mkdirSync(path.join(fx.root, "plain"), { recursive: true })
      const workspaces = fx.workspaces()
      const error = await failure(workspaces.resolveRepo(outside))
      expect(error.code).toBe("directory_invalid")
      expect(error.action).toContain(fx.root)
      expect(await code(workspaces.resolveRepo(`${fx.root}\\repo\\..\\..\\outside`))).toBe("directory_invalid")
      expect(await code(workspaces.resolveRepo(`${fx.root}/repo/../repo`))).toBe("directory_invalid")
      expect(await code(workspaces.resolveRepo(path.join(fx.root, "plain")))).toBe("directory_invalid")
      expect(await code(workspaces.resolveRepo(path.join(fx.root, "missing")))).toBe("directory_invalid")
      expect(await code(workspaces.open(fx.hostRepo, "Bad_Key"))).toBe("invalid_input")
      expect(await code(workspaces.open(fx.hostRepo, "abc"))).toBe("invalid_input")
    },
    T,
  )

  test(
    "normalises case, subdirectories and drive substitutions to the same repo",
    async () => {
      const expected = canonicalPath(fx.hostRepo, {})
      const workspaces = fx.workspaces({ substMap: async () => ({ "Q:": fx.root }) })
      expect(await workspaces.resolveRepo(path.join(fx.hostRepo, "sub"))).toBe(expected)
      if (process.platform === "win32") {
        expect(await workspaces.resolveRepo(fx.hostRepo.toUpperCase())).toBe(expected)
        expect(await workspaces.resolveRepo("q:\\repo")).toBe(expected)
      }
    },
    T,
  )
})
