// Review N1: the box sweep removes only OLD leftover bundles, so a collect in another bridge (which
// holds no lock) never loses its fresh bundle between the in-box write and `docker cp`. The exact
// SWEEP_ARGS run here with a real GNU find against a temp folder standing in for /handoff/out.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { SWEEP_ARGS, SWEEP_MIN_AGE_MINUTES } from "../src/supervisor/handoff-hygiene.ts"
import { runCommand } from "../src/supervisor/workspaces-exec.ts"

/** GNU find: Git for Windows ships one; elsewhere it is on PATH. Windows' own find.exe is not it. */
const FIND = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\find.exe" : "find"
const hasGnuFind = process.platform !== "win32" || existsSync(FIND)

let dir = ""
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ocd-sweep-"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("N1: the sweep removes only old leftover bundles", () => {
  test("argv: no shell, the box-only folder, plain files, the bundle name pattern, older than 30 minutes", () => {
    expect([...SWEEP_ARGS]).toEqual(["find", "/handoff/out", "-maxdepth", "1", "-type", "f", "-name", "*-out.bundle", "-mmin", `+${SWEEP_MIN_AGE_MINUTES}`, "-delete"])
    expect(SWEEP_MIN_AGE_MINUTES).toBe(30)
  })

  // Skipped only where no GNU find exists (Windows without Git for Windows).
  test.skipIf(!hasGnuFind)("a fresh bundle survives; an old one goes; other names and folders stay", async () => {
    const old = Date.now() / 1000 - 2 * 60 * 60
    const make = (name: string, aged: boolean) => {
      writeFileSync(path.join(dir, name), "x")
      if (aged) utimesSync(path.join(dir, name), old, old)
    }
    make("fresh-1111-out.bundle", false)
    make("stale-2222-out.bundle", true)
    make("stale-notes.txt", true)
    mkdirSync(path.join(dir, "dir-3333-out.bundle"))
    utimesSync(path.join(dir, "dir-3333-out.bundle"), old, old)
    const argv = SWEEP_ARGS.map((a) => (a === "/handoff/out" ? dir.replace(/\\/g, "/") : a === "find" ? FIND : a))
    const result = await runCommand(argv)
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" })
    expect(readdirSync(dir).sort()).toEqual(["dir-3333-out.bundle", "fresh-1111-out.bundle", "stale-notes.txt"])
  })
})
