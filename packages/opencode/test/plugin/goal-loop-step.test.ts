import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk"
import {
  GOAL_DEFAULTS,
  continuePrompt,
  decideGoalStep,
  parseGoalArgs,
  readLastTurn,
  type CheckResult,
  type GoalState,
} from "../../src/plugin/goal-loop"

const SESSION = "ses_goal_test"

function goalState(overrides: Partial<GoalState> = {}): GoalState {
  return {
    version: 1,
    sessionID: SESSION,
    goal: "tests pass",
    check: "bun test",
    turns: 0,
    maxTurns: 5,
    maxMinutes: 60,
    timeoutSeconds: 60,
    startedAt: 0,
    status: "active",
    repeats: 0,
    ...overrides,
  }
}

function assistant(input: { error?: { name: string; message?: string }; text?: string; synthetic?: boolean } = {}) {
  const error = input.error
    ? { name: input.error.name, data: input.error.message === undefined ? {} : { message: input.error.message } }
    : undefined
  return {
    info: { role: "assistant", ...(error ? { error } : {}) } as unknown as Message,
    parts: input.text
      ? ([{ type: "text", text: input.text, ...(input.synthetic ? { synthetic: true } : {}) }] as unknown as Part[])
      : [],
  }
}

function user() {
  return {
    info: {
      role: "user",
      agent: "build",
      model: { providerID: "synapse", modelID: "auto" },
    } as unknown as Message,
    parts: [] as Part[],
  }
}

describe("parseGoalArgs", () => {
  test("reads the goal, a quoted check and the budgets", () => {
    expect(
      parseGoalArgs('make the parser tests pass --check "bun test test/parser.test.ts" --turns 8 --minutes 30'),
    ).toEqual({
      action: "start",
      goal: "make the parser tests pass",
      check: "bun test test/parser.test.ts",
      record: undefined,
      turns: 8,
      minutes: 30,
      timeoutSeconds: GOAL_DEFAULTS.timeoutSeconds,
    })
  })

  test("uses the default budgets and accepts a record instead of a check", () => {
    expect(parseGoalArgs("finish run 7 --record .agent-goals/g/runs/r/state.json")).toEqual({
      action: "start",
      goal: "finish run 7",
      check: undefined,
      record: ".agent-goals/g/runs/r/state.json",
      turns: GOAL_DEFAULTS.turns,
      minutes: GOAL_DEFAULTS.minutes,
      timeoutSeconds: GOAL_DEFAULTS.timeoutSeconds,
    })
  })

  test("keeps quotes in the goal text and unquotes only option values", () => {
    expect(
      parseGoalArgs(`set the "state" field to 'done' --check "bun test" --record 'runs/r1/state.json'`),
    ).toMatchObject({
      action: "start",
      goal: `set the "state" field to 'done'`,
      check: "bun test",
      record: "runs/r1/state.json",
    })
  })

  test("a quoted --word is goal text, not an option", () => {
    expect(parseGoalArgs(`explain "--force" in the README --check "bun test"`)).toMatchObject({
      action: "start",
      goal: `explain "--force" in the README`,
    })
  })

  test("reads the control words", () => {
    expect(parseGoalArgs("stop")).toEqual({ action: "stop" })
    expect(parseGoalArgs(" Status ")).toEqual({ action: "status" })
    expect(parseGoalArgs("resume")).toEqual({ action: "resume" })
  })

  test("refuses a goal with no way to check it", () => {
    expect(parseGoalArgs("make it better").action).toBe("error")
  })

  test("refuses an empty goal, bad numbers, unknown options and missing values", () => {
    expect(parseGoalArgs('--check "bun test"').action).toBe("error")
    expect(parseGoalArgs('x --check "bun test" --turns 0').action).toBe("error")
    expect(parseGoalArgs('x --check "bun test" --turns 2.5').action).toBe("error")
    expect(parseGoalArgs('x --check "bun test" --forever yes').action).toBe("error")
    expect(parseGoalArgs("x --check").action).toBe("error")
  })
})

describe("readLastTurn", () => {
  test("a user abort pauses", () => {
    expect(readLastTurn([user(), assistant({ error: { name: "MessageAbortedError" } })]).pause).toBe(
      "aborted by the user",
    )
  })

  test("a failed turn is reported as failed, with its message cut, not as a pause (#327)", () => {
    const turn = readLastTurn([user(), assistant({ error: { name: "UnknownError", message: "upstream  503\n busy" } })])
    expect(turn.pause).toBeUndefined()
    expect(turn.failed).toBe("UnknownError: upstream 503 busy")
    expect(readLastTurn([user(), assistant({ error: { name: "APIError" } })]).failed).toBe("APIError")
    const long = readLastTurn([user(), assistant({ error: { name: "UnknownError", message: "x".repeat(500) } })])
    expect(long.failed).toBe(`UnknownError: ${"x".repeat(200)}`)
  })

  test("GOAL_BLOCKED on its own line pauses with the reason", () => {
    expect(readLastTurn([user(), assistant({ text: "I tried.\nGOAL_BLOCKED: need the staging password" })]).pause).toBe(
      "blocked: need the staging password",
    )
  })

  test("synthetic text and a normal turn do not pause", () => {
    expect(readLastTurn([user(), assistant({ text: "GOAL_BLOCKED: x", synthetic: true })]).pause).toBeUndefined()
    expect(readLastTurn([user(), assistant({ text: "Fixed one test." })]).pause).toBeUndefined()
    expect(readLastTurn([]).pause).toBeUndefined()
  })
})

describe("decideGoalStep", () => {
  const failing: CheckResult = { code: 1, output: "1 fail\nexpected 2, got 3" }

  test("a passing check stops with GOAL_MET", () => {
    expect(decideGoalStep(goalState(), { now: 1, check: { code: 0, output: "" } })).toMatchObject({
      kind: "stop",
      outcome: "GOAL_MET",
    })
  })

  test("a failing check continues and hands back the failure", () => {
    expect(decideGoalStep(goalState(), { now: 1, check: failing })).toEqual({
      kind: "continue",
      failure: failing.output,
    })
  })

  test("the turn budget stops the loop", () => {
    expect(decideGoalStep(goalState({ turns: 5 }), { now: 1, check: failing })).toMatchObject({
      kind: "stop",
      outcome: "BUDGET_EXHAUSTED",
    })
  })

  test("the time budget stops the loop", () => {
    expect(decideGoalStep(goalState(), { now: 60 * 60_000, check: failing })).toMatchObject({
      kind: "stop",
      outcome: "BUDGET_EXHAUSTED",
    })
  })

  test("the same failure three times in a row stops with STALLED", () => {
    const state = goalState({ lastFailure: failing.output, repeats: 2 })
    expect(decideGoalStep(state, { now: 1, check: failing })).toMatchObject({ kind: "stop", outcome: "STALLED" })
    expect(decideGoalStep({ ...state, repeats: 1 }, { now: 1, check: failing }).kind).toBe("continue")
  })

  test("a different duration is still the same failure", () => {
    const state = goalState({ lastFailure: "1 fail [<duration>]", repeats: 2 })
    expect(decideGoalStep(state, { now: 1, check: { code: 1, output: "1 fail [41ms]" } }).kind).toBe("stop")
  })

  test("a terminal portable record stops, PAUSED pauses, and an unreadable record pauses", () => {
    const state = goalState({ check: undefined, record: "state.json" })
    expect(decideGoalStep(state, { now: 1, record: { state: "READY_FOR_APPROVAL" } })).toMatchObject({
      kind: "stop",
      outcome: "READY_FOR_APPROVAL",
    })
    expect(decideGoalStep(state, { now: 1, record: { state: "PAUSED" } }).kind).toBe("pause")
    expect(decideGoalStep(state, { now: 1, record: { error: "bad json" } }).kind).toBe("pause")
    expect(decideGoalStep(state, { now: 1, record: { state: "ACTIVE" } })).toEqual({ kind: "continue" })
  })

  test("the continue prompt carries the turn, the check output and the blocked marker", () => {
    const text = continuePrompt(goalState({ turns: 2 }), { check: failing })
    expect(text).toContain("Turn 2/5")
    expect(text).toContain("expected 2, got 3")
    expect(text).toContain("GOAL_BLOCKED:")
  })
})
