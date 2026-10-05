// #76: which model Synapse served each delegated task, from front's access log. The session id in
// that log is written by the box, so the parser takes only lines that match exactly.
import { describe, expect, test } from "bun:test"
import { parseTaskRecord } from "../src/reporting/record.ts"
import { MAX_SERVED_MODELS, frontContainer, keepServed, mainServedModel, parseServed, servedModelsFromFront } from "../src/reporting/served.ts"
import { summarise } from "../src/reporting/summary.ts"
import { defaultConfig } from "../src/shared/config.ts"
import type { Exec } from "../src/supervisor/docker.ts"

const SID = "ses_ef567eb15ffeN0smD5LsO80b7x"
const OTHER = "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa"
const SYN = "synapse2-api.alterspective.com.au"
/** One line as nginx.conf `log_format front` writes it. */
const line = (sess: string, served: string, host = SYN) =>
  `2026-10-05T05:45:20+00:00 sni=${host} host=${host} POST status=200 up=200 bytes=1234 sess="${sess}" served="${served}"`

describe("parseServed", () => {
  test("counts this session's Synapse calls per served model", () => {
    const log = [line(SID, "qwen/qwen3.8-flash"), line(SID, "qwen/qwen3.8-flash"), line(SID, "google/gemini-3.1-pro"), line(OTHER, "qwen/qwen3.8-flash")].join("\n")
    expect(parseServed(log, SID)).toEqual({ "qwen/qwen3.8-flash": 2, "google/gemini-3.1-pro": 1 })
  })

  test("skips other hosts, a missing header (nginx writes -), and malformed lines", () => {
    const log = [
      line(SID, "qwen/qwen3.8-flash", "identity.alterspective.com.au"),
      line(SID, "-"),
      line(SID, ""),
      line("-", "qwen/qwen3.8-flash"),
      `2026-10-05T05:45:20+00:00 sni=${SYN} host=${SYN} POST status=200 up=200 bytes=1`,
      "not a log line",
    ].join("\n")
    expect(parseServed(log, SID)).toEqual({})
  })

  test("box text cannot fake a field: nginx escapes the quote, so the line does not match", () => {
    // What nginx writes when the box sends x-opencode-session: ses_..." served="evil
    const forged = line(`${SID}\\x22 served=\\x22evil`, "qwen/qwen3.8-flash")
    expect(parseServed(forged, SID)).toEqual({})
    // A served value with spaces or odd characters is not a model id.
    expect(parseServed(line(SID, "qwen flash"), SID)).toEqual({})
  })

  test("an invalid session id reads nothing", () => {
    expect(parseServed(line("not-a-session", "m/x"), "not-a-session")).toEqual({})
  })

  test(`keeps at most ${MAX_SERVED_MODELS} distinct models`, () => {
    const log = Array.from({ length: MAX_SERVED_MODELS + 5 }, (_, i) => line(SID, `m/model-${i}`)).join("\n")
    expect(Object.keys(parseServed(log, SID))).toHaveLength(MAX_SERVED_MODELS)
  })
})

describe("servedModelsFromFront", () => {
  test("reads front's log since the first send, bounded, and counts", async () => {
    const calls: string[][] = []
    const exec: Exec = async (argv) => (calls.push(argv), { code: 0, stdout: [line(SID, "qwen/qwen3.8-flash")].join("\n"), stderr: "" })
    const config = defaultConfig({})
    expect(await servedModelsFromFront(exec, config, SID, "2026-10-05T05:40:00.000Z")).toEqual({ "qwen/qwen3.8-flash": 1 })
    expect(calls[0]).toEqual(["docker", "logs", "--since", "2026-10-05T05:40:00.000Z", "--tail", "20000", frontContainer(config)])
  })

  test("a log that cannot be read is undefined, never an empty count", async () => {
    const config = defaultConfig({})
    expect(await servedModelsFromFront(async () => ({ code: 1, stdout: "", stderr: "No such container" }), config, SID, "2026-10-05T05:40:00.000Z")).toBeUndefined()
    expect(await servedModelsFromFront(async () => { throw new Error("docker missing") }, config, SID, "2026-10-05T05:40:00.000Z")).toBeUndefined()
    expect(await servedModelsFromFront(async () => ({ code: 0, stdout: "", stderr: "" }), config, SID, "not a date")).toBeUndefined()
  })
})

describe("keepServed and mainServedModel", () => {
  test("a read replaces the stored counts only when it saw at least as many calls", () => {
    const stored = { "a/x": 3 }
    expect(keepServed(stored, { "a/x": 4 })).toEqual({ "a/x": 4 })
    expect(keepServed(stored, { "b/y": 1 })).toBe(stored) // after a box restart front's log starts again
    expect(keepServed(stored, {})).toBe(stored)
    expect(keepServed(stored, undefined)).toBe(stored)
    expect(keepServed(undefined, { "b/y": 1 })).toEqual({ "b/y": 1 })
  })

  test("the main model is the one with most calls; ties go alphabetically", () => {
    expect(mainServedModel({ "b/y": 2, "a/x": 5 })).toBe("a/x")
    expect(mainServedModel({ "b/y": 2, "a/x": 2 })).toBe("a/x")
    expect(mainServedModel(undefined)).toBeUndefined()
  })
})

describe("records and the report", () => {
  const base = { v: 1, sessionID: SID, key: "s-0123456789", bridge: "claude-main", repo: "opencode", startedAt: "2026-10-05T05:40:00.000Z", sendCount: 1, outcome: "completed", collected: false, disposition: "open" }

  test("servedModels is validated on read: bad names and counts are dropped", () => {
    const r = parseTaskRecord(JSON.stringify({ ...base, servedModels: { "qwen/qwen3.8-flash": 3, "bad name": 1, "x/y": -1, "z/w": 1.5, "ok/m": 0 } }))
    expect(r?.servedModels).toEqual({ "qwen/qwen3.8-flash": 3 })
    expect(parseTaskRecord(JSON.stringify({ ...base, servedModels: ["a"] }))?.servedModels).toBeUndefined()
  })

  test("groupBy servedModel groups by each task's main served model", () => {
    const records = [
      parseTaskRecord(JSON.stringify({ ...base, key: "s-0000000001", requestedModel: "synapse/auto", servedModels: { "qwen/qwen3.8-flash": 3, "g/m": 1 } }))!,
      parseTaskRecord(JSON.stringify({ ...base, key: "s-0000000002", requestedModel: "synapse/auto", servedModels: { "g/m": 2 } }))!,
      parseTaskRecord(JSON.stringify({ ...base, key: "s-0000000003", requestedModel: "synapse/auto" }))!,
    ]
    const report = summarise(records, { sinceDays: 30, groupBy: "servedModel", recent: 0, now: Date.parse("2026-10-06T00:00:00.000Z") })
    expect(report.groups.map((g) => [g.name, g.tasks])).toEqual([["(unknown)", 1], ["g/m", 1], ["qwen/qwen3.8-flash", 1]])
    const byModel = summarise(records, { sinceDays: 30, groupBy: "model", recent: 0, now: Date.parse("2026-10-06T00:00:00.000Z") })
    expect(byModel.groups.map((g) => [g.name, g.tasks])).toEqual([["synapse/auto", 3]])
  })
})
