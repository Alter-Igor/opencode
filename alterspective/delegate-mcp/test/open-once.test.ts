// iter-8: the dashboard's first browser open (src/dashboard/open-once.ts). One marker per bridge
// home: a missing file opens, a written one never does, and nothing an opener or a disk can do
// takes the bridge down - every failure path returns quietly. The real fs under a temp home, no
// mocks of the module itself; the opener is injected so no browser ever starts in a test.
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DASHBOARD_OPENED_FILE, dashboardOpenedBefore, ensureDashboardOpened } from "../src/dashboard/open-once.ts"
import { silentLogger } from "../src/shared/log.ts"

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "ocd-open-"))
}

const deps = (home: string, opened: string[], failOpen = false, failWrite = false) => ({
  home,
  label: "test-bridge",
  url: "http://127.0.0.1:1/abcd/",
  log: silentLogger,
  open: (url: string) => {
    if (failOpen) throw new Error(`no browser for ${url}`)
    opened.push(url)
  },
  write: failWrite ? () => Promise.reject(new Error("disk full")) : undefined,
})

describe("ensureDashboardOpened", () => {
  test("first run: opens the browser and leaves one marker file holding no URL", async () => {
    const home = await tempHome()
    const opened: string[] = []
    expect(await ensureDashboardOpened(deps(home, opened))).toBe(true)
    expect(opened).toEqual(["http://127.0.0.1:1/abcd/"])
    const files = await readdir(home)
    expect(files.filter((f) => f.startsWith(DASHBOARD_OPENED_FILE))).toEqual([DASHBOARD_OPENED_FILE])
    const marker = await readFile(path.join(home, DASHBOARD_OPENED_FILE), "utf8")
    expect(marker).toContain("test-bridge")
    expect(marker).not.toContain("127.0.0.1")
    expect(await dashboardOpenedBefore(home)).toBe(true)
  })

  test("a written marker means never again: no open, no write", async () => {
    const home = await tempHome()
    await writeFile(path.join(home, DASHBOARD_OPENED_FILE), "2026-10-11T00:00:00.000Z earlier\n")
    const opened: string[] = []
    expect(await ensureDashboardOpened(deps(home, opened))).toBe(false)
    expect(opened).toEqual([])
  })

  test("an empty or whitespace marker file is not a record (treated as absent, then fixed)", async () => {
    const home = await tempHome()
    await writeFile(path.join(home, DASHBOARD_OPENED_FILE), "  \n")
    const opened: string[] = []
    expect(await ensureDashboardOpened(deps(home, opened))).toBe(true)
    expect(opened).toHaveLength(1)
  })

  test("a failing opener: false, nothing written, nothing thrown", async () => {
    const home = await tempHome()
    const opened: string[] = []
    expect(await ensureDashboardOpened(deps(home, opened, true))).toBe(false)
    expect(opened).toEqual([])
    expect(await readdir(home)).toEqual([])
  })

  test("a failing marker write still reports the open (worst case: one extra tab next start)", async () => {
    const home = await tempHome()
    const opened: string[] = []
    expect(await ensureDashboardOpened(deps(home, opened, false, true))).toBe(true)
    expect(opened).toHaveLength(1)
    expect(await readdir(home)).toEqual([])
  })

  test("two callers on one home (bridge start race): one marker file, no .tmp junk, at most two tabs", async () => {
    const home = await tempHome()
    const opened: string[] = []
    const results = await Promise.all([ensureDashboardOpened(deps(home, opened)), ensureDashboardOpened(deps(home, opened))])
    expect(results.some((r) => r)).toBe(true)
    expect(opened.length).toBeGreaterThanOrEqual(1)
    expect(opened.length).toBeLessThanOrEqual(2)
    expect(await readdir(home)).toEqual([DASHBOARD_OPENED_FILE])
  })
})
