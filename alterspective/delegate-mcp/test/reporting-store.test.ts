// #73 delegate reporting: the host-side task record store (one JSON file per task, written
// atomically, retried on Windows EPERM/EBUSY, retention at write and report time) and the report maths.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { newTaskRecord, parseTaskRecord, type TaskRecord } from "../src/reporting/record.ts"
import { createReportStore, REPORT_MAX_AGE_DAYS, REPORT_MAX_RECORDS } from "../src/reporting/store.ts"
import { percentile, median, summarise } from "../src/reporting/summary.ts"

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse("2026-10-03T00:00:00.000Z")
const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), "ocd-report-"))
const errno = (code: string) => Object.assign(new Error(`${code}: rename`), { code })

function rec(key: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...newTaskRecord({ sessionID: `ses_${key.replace(/-/g, "").padEnd(20, "0")}`, key, bridge: "b1", repo: "demo", startedAt: new Date(NOW).toISOString() }), ...overrides }
}

describe("report store", () => {
  test("defaults: 90 days and 2000 records", () => {
    expect(REPORT_MAX_AGE_DAYS).toBe(90)
    expect(REPORT_MAX_RECORDS).toBe(2000)
  })

  test("an update writes one whole file per task (temp file, then rename) and leaves no temp file", async () => {
    const dir = tmpDir()
    const renames: Array<[string, string]> = []
    const store = createReportStore({ dir, now: () => NOW, rename: (a, b) => (renames.push([a, b]), renameSync(a, b)) })
    await store.update("s-0000000001", () => rec("s-0000000001"))
    expect(readdirSync(dir)).toEqual(["s-0000000001.json"])
    expect(renames).toHaveLength(1)
    expect(renames[0]?.[0]).toMatch(/s-0000000001\.json\.\d+\.\d+\.tmp$/)
    expect(renames[0]?.[1]).toBe(path.join(dir, "s-0000000001.json"))
    expect(parseTaskRecord(readFileSync(path.join(dir, "s-0000000001.json"), "utf8"))).toMatchObject({ key: "s-0000000001", outcome: "unknown", disposition: "open" })
  })

  test("a rename that fails with EPERM or EBUSY is retried, then succeeds", async () => {
    const dir = tmpDir()
    const codes = ["EPERM", "EBUSY"]
    let attempts = 0
    const store = createReportStore({
      dir, now: () => NOW, sleep: async () => {},
      rename: (a, b) => {
        attempts++
        const code = codes.shift()
        if (code) throw errno(code)
        renameSync(a, b)
      },
    })
    const saved = await store.update("s-0000000002", () => rec("s-0000000002"))
    expect(attempts).toBe(3)
    expect(saved?.key).toBe("s-0000000002")
    expect(store.get("s-0000000002")?.key).toBe("s-0000000002")
  })

  test("a rename that keeps failing is given up: no throw, the temp file is removed, and it is logged once", async () => {
    const dir = tmpDir()
    const warnings: string[] = []
    let attempts = 0
    const store = createReportStore({ dir, now: () => NOW, sleep: async () => {}, warn: (code) => warnings.push(code), rename: () => {
      attempts++
      throw errno("EPERM")
    } })
    expect(await store.update("s-0000000003", () => rec("s-0000000003"))).toBeUndefined()
    expect(await store.update("s-0000000004", () => rec("s-0000000004"))).toBeUndefined()
    expect(attempts).toBe(10)
    expect(warnings).toEqual(["EPERM"])
    expect(readdirSync(dir)).toEqual([])
  })

  test("other rename errors are not retried", async () => {
    const dir = tmpDir()
    let attempts = 0
    const store = createReportStore({ dir, now: () => NOW, sleep: async () => {}, warn: () => {}, rename: () => {
      attempts++
      throw errno("ENOSPC")
    } })
    await store.update("s-0000000005", () => rec("s-0000000005"))
    expect(attempts).toBe(1)
  })

  test("concurrent updates of one task are applied one after another (no lost update)", async () => {
    const store = createReportStore({ dir: tmpDir(), now: () => NOW })
    await store.update("s-0000000006", () => rec("s-0000000006"))
    await Promise.all(Array.from({ length: 10 }, () => store.update("s-0000000006", (r) => (r ? { ...r, sendCount: r.sendCount + 1 } : r))))
    expect(store.get("s-0000000006")?.sendCount).toBe(10)
  })

  test("an update that returns undefined writes nothing", async () => {
    const dir = tmpDir()
    const store = createReportStore({ dir, now: () => NOW })
    await store.update("s-0000000007", () => undefined)
    expect(existsSync(path.join(dir, "s-0000000007.json"))).toBe(false)
  })

  test("a bad key is refused without touching the folder", async () => {
    const dir = tmpDir()
    const store = createReportStore({ dir, now: () => NOW, warn: () => {} })
    expect(await store.update("../escape", () => rec("s-0000000008"))).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])
  })

  test("damaged and foreign files are skipped by list()", async () => {
    const dir = tmpDir()
    const store = createReportStore({ dir, now: () => NOW })
    await store.update("s-0000000009", () => rec("s-0000000009"))
    writeFileSync(path.join(dir, "s-000000000a.json"), "{not json")
    writeFileSync(path.join(dir, "s-000000000b.json"), JSON.stringify({ v: 1, key: "s-000000000b" }))
    writeFileSync(path.join(dir, "notes.txt"), "hello")
    expect(store.list().map((r) => r.key)).toEqual(["s-0000000009"])
  })

  test("retention drops records older than the age limit and beyond the newest N", async () => {
    const dir = tmpDir()
    const store = createReportStore({ dir, now: () => NOW, maxRecords: 3 })
    const ages = { "s-0000000101": 91, "s-0000000102": 5, "s-0000000103": 4, "s-0000000104": 3, "s-0000000105": 2 }
    for (const [key, days] of Object.entries(ages)) {
      const started = new Date(NOW - days * DAY).toISOString()
      writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(rec(key, { startedAt: started })))
    }
    expect(store.prune()).toBe(2)
    expect(store.list().map((r) => r.key).sort()).toEqual(["s-0000000103", "s-0000000104", "s-0000000105"])
  })

  test("retention also runs when a new task is recorded", async () => {
    const dir = tmpDir()
    writeFileSync(path.join(dir, "s-0000000201.json"), JSON.stringify(rec("s-0000000201", { startedAt: new Date(NOW - 100 * DAY).toISOString() })))
    const store = createReportStore({ dir, now: () => NOW })
    await store.update("s-0000000202", () => rec("s-0000000202"))
    expect(readdirSync(dir).sort()).toEqual(["s-0000000202.json"])
  })
})

describe("record parsing", () => {
  test("keeps only known, valid fields", () => {
    const raw = { ...rec("s-0000000301"), prompt: "secret task text", agent: "build", tokens: { input: 5, output: "x" }, requestedModel: "not a model" }
    const parsed = parseTaskRecord(JSON.stringify(raw))
    expect(parsed).toBeDefined()
    expect(parsed).not.toHaveProperty("prompt")
    expect(parsed).not.toHaveProperty("requestedModel")
    expect(parsed?.agent).toBe("build")
    expect(parsed?.tokens).toEqual({ input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  })

  test("refuses a record without its required fields", () => {
    expect(parseTaskRecord(JSON.stringify({ v: 1 }))).toBeUndefined()
    expect(parseTaskRecord("[]")).toBeUndefined()
  })
})

describe("report maths", () => {
  test("median and p90 (nearest rank)", () => {
    expect(median([])).toBeUndefined()
    expect(median([30, 10, 20])).toBe(20)
    expect(median([10, 20, 30, 40])).toBe(25)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9)
    expect(percentile([10, 20, 30, 40], 90)).toBe(40)
    expect(percentile([7], 90)).toBe(7)
  })

  const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
  const sample: TaskRecord[] = [
    rec("s-0000000401", { requestedModel: "synapse/auto", agent: "build", repo: "alpha", outcome: "completed", durationMs: 1000, collected: true, disposition: "closed_clean", startedAt: at(1) }),
    rec("s-0000000402", { requestedModel: "synapse/auto", agent: "build", repo: "alpha", outcome: "completed", durationMs: 3000, collected: true, disposition: "collected", startedAt: at(2) }),
    rec("s-0000000403", { requestedModel: "synapse/qwen", agent: "plan", repo: "beta", outcome: "error", durationMs: 2000, disposition: "closed_discarded", startedAt: at(3) }),
    rec("s-0000000404", { requestedModel: "synapse/qwen", agent: "build", repo: "beta", outcome: "aborted", durationMs: 9000, disposition: "swept", startedAt: at(4) }),
    rec("s-0000000405", { requestedModel: "synapse/qwen", agent: "build", repo: "beta", outcome: "running", sendCount: 1, startedAt: at(5) }),
    rec("s-0000000406", { requestedModel: "synapse/auto", agent: "build", repo: "alpha", outcome: "completed", durationMs: 5000, startedAt: at(40) }),
  ]

  test("totals, success rate, durations and dispositions over the window", () => {
    const report = summarise(sample, { sinceDays: 30, groupBy: "model", recent: 0, now: NOW })
    expect(report.totals).toMatchObject({ tasks: 5, completed: 2, error: 1, aborted: 1, running: 1, unknown: 0, finished: 4 })
    expect(report.totals.successRate).toBe(0.5)
    expect(report.totals.durationMs).toEqual({ median: 2500, p90: 9000, samples: 4 })
    expect(report.totals.dispositions).toEqual({ collected: 2, closedDiscarded: 1, open: 1, closedClean: 0, swept: 1 })
  })

  test("groupBy model, agent and repo", () => {
    const byModel = summarise(sample, { sinceDays: 30, groupBy: "model", recent: 0, now: NOW }).groups
    expect(byModel.map((g) => [g.name, g.tasks, g.successRate])).toEqual([
      ["synapse/qwen", 3, 0],
      ["synapse/auto", 2, 1],
    ])
    const byAgent = summarise(sample, { sinceDays: 30, groupBy: "agent", recent: 0, now: NOW }).groups
    expect(byAgent.map((g) => [g.name, g.tasks])).toEqual([
      ["build", 4],
      ["plan", 1],
    ])
    const byRepo = summarise(sample, { sinceDays: 60, groupBy: "repo", recent: 0, now: NOW }).groups
    expect(byRepo.map((g) => [g.name, g.tasks, g.durationMs.median])).toEqual([
      ["alpha", 3, 3000],
      ["beta", 3, 5500],
    ])
  })

  test("the served model wins over the requested one when grouping by model; none is (unknown)", () => {
    const groups = summarise([rec("s-0000000501", { requestedModel: "synapse/auto", servedModel: "synapse/qwen-coder" }), rec("s-0000000502")], { sinceDays: 30, groupBy: "model", recent: 0, now: NOW }).groups
    expect(groups.map((g) => g.name).sort()).toEqual(["(unknown)", "synapse/qwen-coder"])
  })

  test("no finished tasks: success rate and durations are null, not zero", () => {
    const report = summarise([rec("s-0000000601", { outcome: "running" })], { sinceDays: 30, groupBy: "model", recent: 0, now: NOW })
    expect(report.totals.successRate).toBeNull()
    expect(report.totals.durationMs).toEqual({ median: null, p90: null, samples: 0 })
  })

  test("recent: the newest N records in the window, newest first", () => {
    const report = summarise(sample, { sinceDays: 30, groupBy: "model", recent: 2, now: NOW })
    expect(report.recent.map((r) => r.key)).toEqual(["s-0000000401", "s-0000000402"])
  })
})
