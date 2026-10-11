// Loop check-in delta: scoreDelta over two scorecards + parseScorecardSnapshot (a corrupt or
// hostile file must read as null = first run, never a crash). Pure functions - no disk, no clock.
import { describe, expect, test } from "bun:test"
import { parseScorecardSnapshot, scorecard, scoreDelta, type ModelScore, type Scorecard } from "../src/reporting/scorecard.ts"
import type { TaskRecord } from "../src/reporting/record.ts"

const NOW = Date.parse("2026-10-11T00:00:00.000Z")
const DAY = 24 * 60 * 60 * 1000

function rec(over: Partial<TaskRecord> & { key: string }): TaskRecord {
  return { v: 1, sessionID: "ses_a1b2c3d4e5f6a7b8", bridge: "b", repo: "r", outcome: "completed", sendCount: 1, startedAt: new Date(NOW - DAY).toISOString(), servedModels: { "openai/gpt-6-astra": 4 }, durationMs: 120_000, ...over } as TaskRecord
}

function card(days: number, models: Array<Partial<ModelScore> & { model: string }>): Scorecard {
  return { generatedAt: new Date(NOW).toISOString(), days, since: new Date(NOW - days * DAY).toISOString(), tasks: 10, models: models.map((m) => ({ kind: "served", tasks: 10, completed: 8, error: 1, aborted: 0, unknown: 0, running: 1, successRate: 8 / 9, medianMs: 60_000, p90Ms: 300_000, tokensIn: 0, tokensOut: 0, repos: 1, errorKinds: {}, ...m })) as ModelScore[] }
}

describe("scoreDelta", () => {
  test("first run: no previous card → firstRun, no lines", () => {
    expect(scoreDelta(card(30, [{ model: "a" }]), null)).toEqual({ firstRun: true, windowMismatch: false, daysFrom: null, lines: [] })
  })

  test("a different window is not comparable: windowMismatch names the old one, lists nothing", () => {
    const d = scoreDelta(card(30, [{ model: "a" }]), card(7, [{ model: "a" }]))
    expect(d).toEqual({ firstRun: false, windowMismatch: true, daysFrom: 7, lines: [] })
  })

  test("no movement → no lines", () => {
    expect(scoreDelta(card(30, [{ model: "a" }]), card(30, [{ model: "a" }])).lines).toEqual([])
  })

  test("a rate change or a task move of ≥0.5 produces a from→to line; a smaller move is noise", () => {
    const d = scoreDelta(card(30, [{ model: "a", successRate: 0.5 }, { model: "b", tasks: 10.3 }]), card(30, [{ model: "a", successRate: 0.8 }, { model: "b", tasks: 10.6 }]))
    expect(d.lines.map((l) => l.model)).toEqual(["a"])
    expect(d.lines[0]).toMatchObject({ rateFrom: 0.8, rateTo: 0.5, tasksFrom: 10, tasksTo: 10, new: false, gone: false, lowN: false })
  })

  test("new and gone rows are flagged; a ghost row keeps its kind", () => {
    const d = scoreDelta(card(30, [{ model: "a" }, { model: "n", completed: 1, error: 1, aborted: 0, unknown: 0, tasks: 2, successRate: 0.5 }]), card(30, [{ model: "a" }, { model: "g", kind: "requested-only" }]))
    expect(d.lines).toEqual([
      { model: "n", kind: "served", rateFrom: null, rateTo: 0.5, tasksFrom: 0, tasksTo: 2, new: true, gone: false, lowN: true },
      { model: "g", kind: "requested-only", rateFrom: 8 / 9, rateTo: null, tasksFrom: 10, tasksTo: 0, new: false, gone: true, lowN: false },
    ])
  })

  test("low n (<5 finished both sides) is flagged, never filtered; a big sample is not flagged", () => {
    const d = scoreDelta(card(30, [{ model: "a", completed: 2, successRate: 0.5 }]), card(30, [{ model: "a", completed: 3, successRate: 0.7 }]))
    expect(d.lines[0]?.lowN).toBe(true)
    const big = scoreDelta(card(30, [{ model: "a" }]), card(30, [{ model: "a", successRate: 0.5 }]))
    expect(big.lines[0]?.lowN).toBe(false)
  })

  test("over real scorecards: a finished-task added since the last run moves a model's numbers", () => {
    const before = scorecard([rec({ key: "x" })], NOW, 30)
    const after = scorecard([rec({ key: "x" }), rec({ key: "y", outcome: "error", errorCode: "other", servedModels: { "openai/gpt-6-astra": 1 } })], NOW, 30)
    const d = scoreDelta(after, before)
    expect(d.firstRun).toBe(false)
    expect(d.lines[0]).toMatchObject({ model: "openai/gpt-6-astra", rateFrom: 1, rateTo: 0.5 })
  })
})

describe("parseScorecardSnapshot", () => {
  test("a real scorecard round-trips the fields the delta needs", () => {
    const c = scorecard([rec({ key: "x", requestedModel: "synapse/ghost-model" })], NOW, 30)
    const p = parseScorecardSnapshot(JSON.parse(JSON.stringify(c)))
    expect(p?.days).toBe(30)
    expect(p?.models.map((m) => `${m.kind} ${m.model}`)).toEqual(c.models.map((m) => `${m.kind} ${m.model}`))
    expect(p?.models.find((m) => m.model === "ghost-model")?.kind).toBe("requested-only")
  })

  test("null/garbage/wrong-shape reads as null (first run), never throws", () => {
    for (const bad of [undefined, null, 42, "x", {}, { days: 30 }, { days: "30", tasks: 1, models: [] }, { days: 30, tasks: 1, models: [{}] }, { days: 30, tasks: 1, models: [{ model: "a", kind: "weird", tasks: 1 }] }, { days: 30, tasks: 1, models: [{ model: "a", kind: "served", tasks: "1" }] }, { days: 30, tasks: 1, models: [{ model: "a", kind: "served", tasks: 1, successRate: "high" }] }]) {
      expect(parseScorecardSnapshot(bad)).toBeNull()
    }
  })
})
