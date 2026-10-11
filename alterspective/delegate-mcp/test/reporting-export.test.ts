// D7 (owner ask 2026-10-11): the outcome exporter feeds Synapse's benchmark/suitability loop.
// Rows only for settled tasks that named a served model; repo/caller hashed with a per-home salt
// unless --no-redact; the CLI surfaces it as `outcomes [--days N] [--no-redact]`.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { outcomeRows, redact, EXPORT_VERSION } from "../src/reporting/export.ts"
import type { TaskRecord } from "../src/reporting/record.ts"
import { parseCli, runOutcomes, EXIT, type Io } from "../src/cli.ts"
import type { Runtime } from "../src/runtime.ts"
import { fakeContext, record } from "./tools-core-fixture.ts"

const NOW = Date.parse("2026-10-11T00:00:00.000Z")
const DAY = 24 * 60 * 60 * 1000

function rec(over: Partial<TaskRecord> & { key: string }): TaskRecord {
  return { v: 1, sessionID: "ses_a1b2c3d4e5f6a7b8", bridge: "claude-main", repo: "client-fin-app", caller: "sensitive-folder", outcome: "completed", sendCount: 2, collected: true, disposition: "closed_clean", startedAt: new Date(NOW - DAY).toISOString(), servedModels: { "openai/gpt-6-astra": 4 }, durationMs: 120_000, tokens: { input: 50_000, output: 2_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, ...over } as TaskRecord
}

describe("outcomeRows", () => {
  test("a settled task with served models becomes one row, oldest first", () => {
    const rows = outcomeRows([rec({ key: "b" }), rec({ key: "a", startedAt: new Date(NOW - 2 * DAY).toISOString() })], { now: NOW, salt: "s" })
    expect(rows.map((r) => r.taskKey)).toEqual(["a", "b"])
    expect(rows[0]).toMatchObject({ v: EXPORT_VERSION, outcome: "completed", mainModel: "openai/gpt-6-astra", sendCount: 2, collected: true })
  })

  test("running, aborted, unsent-unknown, empty-served and no-model tasks are not exported", () => {
    const rows = outcomeRows([
      rec({ key: "run", outcome: "running" }),
      rec({ key: "ab", outcome: "aborted" }),
      rec({ key: "unsent", outcome: "unknown", sendCount: 0 }),
      rec({ key: "nomodel", servedModels: undefined }),
      rec({ key: "empty", servedModels: {} }),
    ], { now: NOW, salt: "s" })
    expect(rows).toEqual([])
  })

  test("names are hashed with the salt by default and verbatim under redactNames:false", () => {
    const salt = "salt123"
    const hashed = outcomeRows([rec({ key: "h" })], { now: NOW, salt })[0]!
    expect(hashed.repo).toBe(redact(salt, "client-fin-app"))
    expect(hashed.caller).toBe(redact(salt, "sensitive-folder"))
    expect(hashed.repo).not.toContain("client")
    const plain = outcomeRows([rec({ key: "p" })], { now: NOW, salt, redactNames: false })[0]!
    expect(plain.repo).toBe("client-fin-app")
  })

  test("the salt is stable across calls, and a different salt gives a different hash (unlinkable)", () => {
    expect(redact("a", "x")).toBe(redact("a", "x"))
    expect(redact("a", "x")).not.toBe(redact("b", "x"))
  })

  test("rows older than the window are excluded", () => {
    const rows = outcomeRows([rec({ key: "old", startedAt: new Date(NOW - 400 * DAY).toISOString() }), rec({ key: "new" })], { now: NOW, days: 365, salt: "s" })
    expect(rows.map((r) => r.taskKey)).toEqual(["new"])
  })
})

function io(): Io & { lines: string[]; errs: string[] } {
  const lines: string[] = []
  const errs: string[] = []
  return { lines, errs, out: (t) => lines.push(t), err: (t) => errs.push(t) }
}

/** A runtime with its own fresh home whose store holds real files, like production. */
async function runtimeWith(records: TaskRecord[]): Promise<() => Promise<Runtime>> {
  const f = fakeContext()
  f.ctx.config.home = await mkdtemp(path.join(os.tmpdir(), "ocd-export-"))
  const dir = path.join(f.ctx.config.home, "workspaces", "reports")
  await mkdir(dir, { recursive: true })
  for (const record of records) await Bun.write(path.join(dir, `${record.key}.json`), JSON.stringify(record))
  return async () => ({ ctx: f.ctx, versionInfo: { version: "v", package: "0", sha: "x", dirty: false, built: null }, name: "cli-test", shutdown: async () => {} }) as unknown as Runtime
}

describe("cli outcomes", () => {
  test("parse: default 90d redacted, --days, --no-redact, and bad input", () => {
    expect(parseCli(["outcomes"])).toEqual({ kind: "outcomes", days: 90, redact: true })
    expect(parseCli(["outcomes", "--days", "7", "--no-redact"])).toEqual({ kind: "outcomes", days: 7, redact: false })
    expect(parseCli(["outcomes", "--days", "0"])).toMatchObject({ kind: "error" })
    expect(parseCli(["outcomes", "--bogus"])).toMatchObject({ kind: "error" })
  })

  test("writes one JSON line per settled record and exits 0", async () => {
    // relative to the real clock: runOutcomes windows on Date.now(), so a fixed NOW would age out
    const live = new Date(Date.now() - 60_000).toISOString()
    const make = await runtimeWith([rec({ key: "s-0000000001", startedAt: live }), rec({ key: "s-0000000002", startedAt: live, outcome: "running" })])
    const out = io()
    expect(await runOutcomes(out, 90, true, make)).toBe(EXIT.ok)
    expect(out.lines).toHaveLength(1)
    expect(JSON.parse(out.lines[0]!)).toMatchObject({ taskKey: "s-0000000001", outcome: "completed" })
    expect(out.lines[0]).not.toContain("client-fin-app") // hashed by default
    expect(out.errs.join("")).toContain("1 outcome row(s) of 2 record(s)")
  })

  test("empty store: no lines, exit 0", async () => {
    const out = io()
    expect(await runOutcomes(out, 90, true, await runtimeWith([]))).toBe(EXIT.ok)
    expect(out.lines).toEqual([])
  })
})
