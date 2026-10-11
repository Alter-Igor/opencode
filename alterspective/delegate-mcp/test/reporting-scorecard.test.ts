// Per-model scorecard: share-weighting, ghost (requested-not-served) rows kept separate,
// successRate over settled tasks only, and the mainServed view. Pure function over TaskRecord[].
import { describe, expect, test } from "bun:test"
import { scorecard, scoreForMainServed, servingHistory } from "../src/reporting/scorecard.ts"
import type { TaskRecord } from "../src/reporting/record.ts"

const NOW = Date.parse("2026-10-11T00:00:00.000Z")
const DAY = 24 * 60 * 60 * 1000

function rec(over: Partial<TaskRecord> & { key: string; startedAt?: string }): TaskRecord {
  return { v: 1, sessionID: "ses_" + over.key, bridge: "claude-main", repo: "demo", outcome: "completed", sendCount: 1, collected: true, disposition: "closed_clean", startedAt: new Date(NOW - DAY).toISOString(), ...over } as TaskRecord
}

describe("scorecard", () => {
  test("splits a task across models by call share", () => {
    const card = scorecard([rec({ key: "a", servedModels: { astra: 3, kimi: 1 }, outcome: "completed" })], NOW)
    const astra = card.models.find((m) => m.model === "astra")
    const kimi = card.models.find((m) => m.model === "kimi")
    expect(astra?.tasks).toBeCloseTo(0.75)
    expect(kimi?.tasks).toBeCloseTo(0.25)
    expect(astra?.completed).toBeCloseTo(0.75)
  })

  test("a model requested but never served is a requested-only ghost, not mixed with servers", () => {
    const card = scorecard([rec({ key: "g", requestedModel: "synapse/claude-opus-5", servedModels: { "qwen3.8": 2 }, outcome: "error", errorCode: "other" })], NOW)
    const ghost = card.models.find((m) => m.model === "claude-opus-5")
    const server = card.models.find((m) => m.model === "qwen3.8")
    expect(ghost?.kind).toBe("requested-only")
    expect(ghost?.tasks).toBe(1)
    expect(ghost?.error).toBe(1)
    expect(server?.kind).toBe("served")
    expect(server?.errorKinds.other).toBe(2 / 2)
  })

  test("synapse/auto is never a re-routed ghost: it is a routing alias, not an ask that died", () => {
    const card = scorecard([
      rec({ key: "a1", requestedModel: "synapse/auto", servedModels: { "openai/gpt-6-astra": 3 }, outcome: "completed" }),
      rec({ key: "a2", requestedModel: "synapse/auto", servedModels: { kimi: 2 }, outcome: "completed" }),
    ], NOW)
    expect(card.models.find((m) => m.model === "auto")).toBeUndefined()
    expect(card.models.find((m) => m.model === "openai/gpt-6-astra")?.kind).toBe("served")
  })

  test("successRate counts settled tasks only (running excluded), sorted by tasks desc", () => {
    const card = scorecard([
      rec({ key: "c1", servedModels: { astra: 5 }, outcome: "completed" }),
      rec({ key: "c2", servedModels: { astra: 5 }, outcome: "completed" }),
      rec({ key: "c3", servedModels: { astra: 5 }, outcome: "error", errorCode: "rate_limited" }),
      rec({ key: "c4", servedModels: { astra: 5 }, outcome: "running" }),
    ], NOW)
    const astra = card.models.find((m) => m.model === "astra")!
    expect(astra.successRate).toBeCloseTo(2 / 3)
    expect(astra.unknown).toBe(0)
    expect(astra.tasks).toBe(4)
    expect(astra.errorKinds.rate_limited).toBe(1)
  })

  test("tasks older than the window are excluded", () => {
    const card = scorecard([
      rec({ key: "old", startedAt: new Date(NOW - 10 * DAY).toISOString(), servedModels: { astra: 1 } }),
      rec({ key: "new", startedAt: new Date(NOW - DAY).toISOString(), servedModels: { kimi: 1 } }),
    ], NOW, 7)
    expect(card.tasks).toBe(1)
    expect(card.models.find((m) => m.model === "astra")).toBeUndefined()
    expect(card.models.find((m) => m.model === "kimi")?.tasks).toBe(1)
  })

  test("duration median/p90 ignore running tasks", () => {
    const card = scorecard([
      rec({ key: "d1", servedModels: { astra: 1 }, outcome: "completed", durationMs: 60_000 }),
      rec({ key: "d2", servedModels: { astra: 1 }, outcome: "completed", durationMs: 120_000 }),
      rec({ key: "d3", servedModels: { astra: 1 }, outcome: "running", durationMs: 9_000_000 }),
    ], NOW)
    const astra = card.models.find((m) => m.model === "astra")!
    expect(astra.medianMs).toBe(90_000) // summary.ts median: even counts average the two middle values
    expect(astra.p90Ms).toBe(120_000)
  })

  test("a task with no servedModels contributes to the task count but not to any model", () => {
    const card = scorecard([rec({ key: "x", outcome: "completed" })], NOW)
    expect(card.tasks).toBe(1)
    expect(card.models).toEqual([])
  })

  test("scoreForMainServed groups each task under the model that carried most calls", () => {
    const rows = scoreForMainServed([
      rec({ key: "m1", servedModels: { astra: 4, kimi: 1 }, outcome: "completed" }),
      rec({ key: "m2", servedModels: { kimi: 3, astra: 1 }, outcome: "completed" }),
    ], NOW)
    expect(rows.find((m) => m.model === "astra")?.tasks).toBe(1)
    expect(rows.find((m) => m.model === "kimi")?.tasks).toBe(1)
  })
})

describe("servingHistory", () => {
  test("completed tasks credit wins by served share", () => {
    const h = servingHistory([rec({ key: "w", servedModels: { astra: 3, kimi: 1 }, outcome: "completed" })], NOW)
    expect(h.wins.astra).toBeCloseTo(0.75)
    expect(h.wins.kimi).toBeCloseTo(0.25)
    expect(h.dead).toEqual([])
  })

  test("an errored task whose asked model never served a call is a dead route (the ghost 404 class)", () => {
    const h = servingHistory([
      rec({ key: "d1", requestedModel: "synapse/claude-opus-5", servedModels: { qwen: 2 }, outcome: "error", errorCode: "other" }),
      rec({ key: "d2", requestedModel: "synapse/claude-opus-5", servedModels: { qwen: 1 }, outcome: "error", errorCode: "other" }),
    ], NOW)
    expect(h.dead).toEqual(["claude-opus-5"])
  })

  test("positive evidence outranks suspicion: a dead-route id with any win in the window is not dead", () => {
    const h = servingHistory([
      rec({ key: "e", requestedModel: "synapse/maybe", servedModels: { other: 1 }, outcome: "error" }),
      rec({ key: "c", servedModels: { maybe: 4 }, outcome: "completed" }),
    ], NOW)
    expect(h.dead).toEqual([])
  })

  test("a model that served a call on an errored task is flaky, not dead: no completed wins still clears the flag", () => {
    const h = servingHistory([
      rec({ key: "e1", requestedModel: "synapse/ghosty", servedModels: { astra: 2 }, outcome: "error" }),
      rec({ key: "e2", requestedModel: "synapse/ghosty", servedModels: { ghosty: 1 }, outcome: "error" }),
    ], NOW)
    expect(h.dead).toEqual([])
  })

  test("auto never flags; error tasks WITH the asked model present are not dead; old records age out", () => {
    const h = servingHistory([
      rec({ key: "a", requestedModel: "synapse/auto", servedModels: { astra: 1 }, outcome: "error" }),
      rec({ key: "b", requestedModel: "synapse/astra", servedModels: { astra: 1 }, outcome: "error" }),
      rec({ key: "c", requestedModel: "synapse/stale-ghost", servedModels: {}, outcome: "error", startedAt: new Date(NOW - 40 * DAY).toISOString() }),
    ], NOW)
    expect(h.dead).toEqual([])
  })
})
