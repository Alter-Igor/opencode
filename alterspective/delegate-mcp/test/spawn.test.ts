// Review N-4: a timeout kills the whole process tree, and no call waits forever on pipes a
// grandchild keeps open. Real processes (this Bun binary as child and grandchild), no fakes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { bunExec, EXIT_TIMED_OUT } from "../src/supervisor/docker.ts"
import { processAlive } from "../src/supervisor/process.ts"
import { KILL_GRACE_MS, runProcess } from "../src/supervisor/spawn.ts"
import { runCommand, TIMEOUT_CODE } from "../src/supervisor/workspaces-exec.ts"

const bun = process.execPath
let dir = ""
let parentScript = ""
let exitingParentScript = ""
/** Grandchild PIDs seen by the tests; any still alive at the end are ended by exact PID. */
const grandchildren: number[] = []

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ocd-spawn-"))
  // The child starts a grandchild that inherits stdout/stderr and sleeps for a minute.
  const spawnGrandchild = [
    'import { spawn } from "node:child_process"',
    'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "inherit"] })',
    'process.stdout.write(`parent ${process.pid}\\ngrandchild ${g.pid}\\n`)',
  ].join("\n")
  parentScript = path.join(dir, "parent.mjs")
  writeFileSync(parentScript, `${spawnGrandchild}\nsetTimeout(() => {}, 60000)\n`)
  exitingParentScript = path.join(dir, "exiting-parent.mjs")
  writeFileSync(exitingParentScript, `${spawnGrandchild}\nsetTimeout(() => process.exit(0), 200)\n`)
})

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300))
  for (const pid of grandchildren) {
    if (processAlive(pid)) {
      try {
        process.kill(pid) // exact PID of a process this test started
      } catch {
        // already gone
      }
    }
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** The deepest descendant's PID; every descendant PID printed is kept for the final clean-up. */
function grandchildPid(stdout: string): number {
  const parent = Number(/parent (\d+)/.exec(stdout)?.[1])
  const pid = Number(/grandchild (\d+)/.exec(stdout)?.[1])
  for (const p of [parent, pid]) if (Number.isInteger(p) && p > 0) grandchildren.push(p)
  return pid
}

async function gone(pid: number, withinMs = 5_000): Promise<boolean> {
  const until = Date.now() + withinMs
  while (Date.now() < until) {
    if (!processAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !processAlive(pid)
}

/**
 * The command under test. On Windows the direct child is cmd.exe, not Bun: a Bun child seems to
 * take its own children down with it, which would hide a kill that reaches the child only.
 * git and docker (the real children) do not do that.
 */
const viaShell = (script: string) => (process.platform === "win32" ? [process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", "/d", "/c", bun, script] : [bun, script])

const TIMEOUT = 1_500
/** timeout + grace, plus slack for a loaded machine (process start, taskkill). */
const BOUND = TIMEOUT + KILL_GRACE_MS + 4_000

describe("process tree on timeout (N-4)", () => {
  test("runCommand returns within timeout + grace and the grandchild is killed too", async () => {
    const started = Date.now()
    const result = await runCommand(viaShell(parentScript), process.env, TIMEOUT)
    const took = Date.now() - started
    expect(result.code).toBe(TIMEOUT_CODE)
    expect(result.timedOut).toBe(true)
    expect(took).toBeLessThan(BOUND)
    const pid = grandchildPid(result.stdout)
    expect(pid).toBeGreaterThan(0)
    expect(await gone(pid)).toBe(true)
  }, 30_000)

  test("bunExec returns within timeout + grace and the grandchild is killed too", async () => {
    const started = Date.now()
    const result = await bunExec(viaShell(parentScript), { env: { ...process.env } as Record<string, string>, timeoutMs: TIMEOUT })
    expect(result.code).toBe(EXIT_TIMED_OUT)
    expect(Date.now() - started).toBeLessThan(BOUND)
    expect(await gone(grandchildPid(result.stdout))).toBe(true)
  }, 30_000)

  test("a child that exits while its grandchild holds stdout: returned after the grace, not after the grandchild", async () => {
    const started = Date.now()
    const result = await runProcess(viaShell(exitingParentScript), { env: process.env, graceMs: 500 })
    const took = Date.now() - started
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(took).toBeLessThan(10_000) // the grandchild sleeps 60 s
    expect(grandchildPid(result.stdout)).toBeGreaterThan(0)
  }, 30_000)
})
