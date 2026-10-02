// #73 delegate reporting: the host-side task record store (one JSON file per task, written
// atomically, retried on Windows EPERM/EBUSY, retention at write and report time) and the report maths.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { errorCode, newTaskRecord, parseTaskRecord, type TaskRecord } from "../src/reporting/record.ts"
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
      writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(rec(key, { startedAt: started, disposition: "closed_clean" })))
    }
    expect(store.prune()).toBe(2)
    expect(store.list().map((r) => r.key).sort()).toEqual(["s-0000000103", "s-0000000104", "s-0000000105"])
  })

  test("open tasks are exempt from the count cap, but not from the age limit", async () => {
    const dir = tmpDir()
    const store = createReportStore({ dir, now: () => NOW, maxRecords: 2 })
    const rows: Array<[string, number, TaskRecord["disposition"]]> = [
      ["s-0000000111", 1, "closed_clean"],
      ["s-0000000112", 2, "closed_clean"],
      ["s-0000000113", 3, "open"],
      ["s-0000000114", 4, "closed_clean"],
      ["s-0000000115", 5, "open"],
      ["s-0000000116", 95, "open"],
    ]
    for (const [key, days, disposition] of rows) writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(rec(key, { startedAt: new Date(NOW - days * DAY).toISOString(), disposition })))
    store.prune()
    expect(store.list().map((r) => r.key).sort()).toEqual(["s-0000000111", "s-0000000112", "s-0000000113", "s-0000000115"])
  })

  test("two stores on one folder (two bridge processes) do not lose an update", async () => {
    const dir = tmpDir()
    const slow = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    let failNext = false
    // A's rename fails once with EBUSY, so A sits between its read and its write while B runs.
    const a = createReportStore({ dir, now: () => NOW, sleep: () => slow(60), rename: (from, to) => {
      if (failNext) {
        failNext = false
        throw errno("EBUSY")
      }
      renameSync(from, to)
    } })
    const b = createReportStore({ dir, now: () => NOW })
    await b.update("s-0000000121", () => rec("s-0000000121"))
    failNext = true
    const bump = (r: TaskRecord | undefined) => (r ? { ...r, sendCount: r.sendCount + 1 } : r)
    const first = a.update("s-0000000121", bump)
    await slow(10)
    await Promise.all([first, b.update("s-0000000121", bump)])
    expect(a.get("s-0000000121")?.sendCount).toBe(2)
    expect(readdirSync(dir).filter((n) => n.endsWith(".lock"))).toEqual([])
  })

  test("a lock another process holds: the update is skipped and logged once, never thrown", async () => {
    const dir = tmpDir()
    const warnings: string[] = []
    const store = createReportStore({ dir, now: () => NOW, sleep: async () => {}, warn: (code) => warnings.push(code) })
    await store.update("s-0000000131", () => rec("s-0000000131"))
    writeFileSync(path.join(dir, "s-0000000131.json.lock"), "other")
    expect(await store.update("s-0000000131", (r) => (r ? { ...r, sendCount: 5 } : r))).toBeUndefined()
    expect(await store.update("s-0000000131", (r) => (r ? { ...r, sendCount: 6 } : r))).toBeUndefined()
    expect(store.get("s-0000000131")?.sendCount).toBe(0)
    expect(warnings).toEqual(["lock_busy"])
  })

  test("a stale lock (older than about 10 s) is taken over", async () => {
    const dir = tmpDir()
    const store = createReportStore({ dir, now: () => NOW, sleep: async () => {} })
    await store.update("s-0000000141", () => rec("s-0000000141"))
    const lock = path.join(dir, "s-0000000141.json.lock")
    writeFileSync(lock, "crashed writer")
    const old = new Date(Date.now() - 20_000)
    utimesSync(lock, old, old)
    expect((await store.update("s-0000000141", (r) => (r ? { ...r, sendCount: 7 } : r)))?.sendCount).toBe(7)
    expect(existsSync(lock)).toBe(false)
  })

  test("a lock dated in the future counts as stale and is taken over", async () => {
    const dir = tmpDir()
    const store = createReportStore({ dir, now: () => NOW, sleep: async () => {} })
    await store.update("s-0000000151", () => rec("s-0000000151"))
    const lock = path.join(dir, "s-0000000151.json.lock")
    writeFileSync(lock, "clock skew")
    const future = new Date(Date.now() + 60_000)
    utimesSync(lock, future, future)
    expect((await store.update("s-0000000151", (r) => (r ? { ...r, sendCount: 3 } : r)))?.sendCount).toBe(3)
  })

  test("two takers racing on one stale lock: only one takes it, the other waits its turn, nothing is lost", async () => {
    const dir = tmpDir()
    const slow = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const setup = createReportStore({ dir, now: () => NOW })
    await setup.update("s-0000000161", () => rec("s-0000000161"))
    const lock = path.join(dir, "s-0000000161.json.lock")
    writeFileSync(lock, "crashed writer")
    const old = new Date(Date.now() - 20_000)
    utimesSync(lock, old, old)
    // Both takers see the stale lock before either acts on it.
    let arrived = 0
    const gate = async () => {
      arrived++
      while (arrived < 2) await slow(2)
    }
    // B arrives second, so it takes the stale lock first; it then holds it across an await (a slow
    // rename) while A, waking, moves B's fresh lock aside and must put it back instead of going on.
    let failNext = true
    const a = createReportStore({ dir, now: () => NOW, onStaleLock: gate })
    const b = createReportStore({ dir, now: () => NOW, sleep: () => slow(40), onStaleLock: gate, rename: (from, to) => {
      if (failNext) {
        failNext = false
        throw errno("EBUSY")
      }
      renameSync(from, to)
    } })
    const bump = (r: TaskRecord | undefined) => (r ? { ...r, sendCount: r.sendCount + 1 } : r)
    await Promise.all([a.update("s-0000000161", bump), b.update("s-0000000161", bump)])
    expect(setup.get("s-0000000161")?.sendCount).toBe(2)
    expect(readdirSync(dir).sort()).toEqual(["s-0000000161.json"])
  })

  test("release deletes only its own lock", async () => {
    const dir = tmpDir()
    const lock = path.join(dir, "s-0000000171.json.lock")
    let failNext = true
    const store = createReportStore({ dir, now: () => NOW, sleep: async () => writeFileSync(lock, "someone else took it over"), rename: (from, to) => {
      if (failNext) {
        failNext = false
        throw errno("EBUSY")
      }
      renameSync(from, to)
    } })
    await store.update("s-0000000171", () => rec("s-0000000171"))
    expect(readFileSync(lock, "utf8")).toBe("someone else took it over")
  })

  test("retention removes stale lock files that have no record, and keeps the rest", async () => {
    const dir = tmpDir()
    const store = createReportStore({ dir, now: () => NOW })
    await store.update("s-0000000181", () => rec("s-0000000181"))
    const old = new Date(Date.now() - 20_000)
    for (const name of ["s-0000000181.json.lock", "s-0000000182.json.lock", "s-0000000183.json.lock"]) writeFileSync(path.join(dir, name), "x")
    utimesSync(path.join(dir, "s-0000000181.json.lock"), old, old)
    utimesSync(path.join(dir, "s-0000000182.json.lock"), old, old)
    store.prune()
    expect(readdirSync(dir).sort()).toEqual(["s-0000000181.json", "s-0000000181.json.lock", "s-0000000183.json.lock"])
  })

  test("a failed link-back of a moved live lock is logged once, with the key and error code only", async () => {
    const dir = tmpDir()
    const slow = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const setup = createReportStore({ dir, now: () => NOW })
    await setup.update("s-0000000165", () => rec("s-0000000165"))
    const lock = path.join(dir, "s-0000000165.json.lock")
    writeFileSync(lock, "crashed writer")
    const old = new Date(Date.now() - 20_000)
    utimesSync(lock, old, old)
    let arrived = 0
    const gate = async () => {
      arrived++
      while (arrived < 2) await slow(2)
    }
    const warnings: Array<[string, unknown]> = []
    const a = createReportStore({ dir, now: () => NOW, onStaleLock: gate, warn: (code, fields) => warnings.push([code, fields]), link: () => {
      throw errno("EEXIST")
    } })
    let failNext = true
    const b = createReportStore({ dir, now: () => NOW, sleep: () => slow(40), onStaleLock: gate, rename: (from, to) => {
      if (failNext) {
        failNext = false
        throw errno("EBUSY")
      }
      renameSync(from, to)
    } })
    const bump = (r: TaskRecord | undefined) => (r ? { ...r, sendCount: r.sendCount + 1 } : r)
    await Promise.all([a.update("s-0000000165", bump), b.update("s-0000000165", bump)])
    expect(warnings).toEqual([["lock_relink_failed", { key: "s-0000000165", errno: "EEXIST" }]])
  })

  test("flush() waits for updates that were queued without being awaited", async () => {
    const dir = tmpDir()
    const store = createReportStore({ dir, now: () => NOW })
    void store.update("s-0000000191", () => rec("s-0000000191"))
    void store.update("s-0000000192", () => rec("s-0000000192"))
    await store.flush()
    expect(readdirSync(dir).sort()).toEqual(["s-0000000191.json", "s-0000000192.json"])
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
    const raw = { ...rec("s-0000000301"), prompt: "secret task text", agent: "build", tokens: { input: 5, output: "x" }, requestedModel: "not a model", servedModel: "synapse/auto", errorCode: "Some box text 123" }
    const parsed = parseTaskRecord(JSON.stringify(raw))
    expect(parsed).toBeDefined()
    expect(parsed).not.toHaveProperty("prompt")
    expect(parsed).not.toHaveProperty("requestedModel")
    expect(parsed).not.toHaveProperty("servedModel")
    expect(parsed?.errorCode).toBe("other")
    expect(parsed?.agent).toBe("build")
    expect(parsed?.tokens).toEqual({ input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  })

  test("errorCode allowlist: bridge error codes and OpenCode error names kept, anything else is other", () => {
    expect(errorCode("not_started")).toBe("not_started")
    expect(errorCode("upstream_error")).toBe("upstream_error")
    expect(errorCode("ProviderAuthError")).toBe("ProviderAuthError")
    expect(errorCode("unrecognised error")).toBe("other")
    expect(errorCode("rm -rf /")).toBe("other")
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
    expect(report.totals).toMatchObject({ tasks: 5, completed: 2, error: 1, aborted: 1, running: 1, unknown: 0, notSent: 0, finished: 4 })
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

  test("groupBy model uses the model actually sent; none is (unknown)", () => {
    const groups = summarise([rec("s-0000000501", { requestedModel: "synapse/qwen-coder" }), rec("s-0000000502")], { sinceDays: 30, groupBy: "model", recent: 0, now: NOW }).groups
    expect(groups.map((g) => g.name).sort()).toEqual(["(unknown)", "synapse/qwen-coder"])
  })

  test("an unknown outcome after a send counts as finished and lowers the rate; a task never sent does not", () => {
    const report = summarise(
      [
        rec("s-0000000511", { outcome: "completed", sendCount: 1, durationMs: 10 }),
        rec("s-0000000512", { outcome: "unknown", sendCount: 2, durationMs: 30 }),
        rec("s-0000000513", { outcome: "unknown", sendCount: 0 }),
      ],
      { sinceDays: 30, groupBy: "model", recent: 0, now: NOW },
    )
    expect(report.totals).toMatchObject({ tasks: 3, completed: 1, unknown: 2, notSent: 1, finished: 2, successRate: 0.5 })
    expect(report.totals.durationMs).toEqual({ median: 20, p90: 30, samples: 2 })
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
