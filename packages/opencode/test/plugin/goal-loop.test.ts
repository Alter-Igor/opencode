import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Config, PluginInput } from "@opencode-ai/plugin"
import type { Message, Part } from "@opencode-ai/sdk"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  GOAL_DEFAULTS,
  GoalLoopPlugin,
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

function assistant(input: { error?: { name: string }; text?: string; synthetic?: boolean } = {}) {
  return {
    info: { role: "assistant", ...(input.error ? { error: { ...input.error, data: {} } } : {}) } as unknown as Message,
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

  test("a failed turn pauses", () => {
    expect(readLastTurn([user(), assistant({ error: { name: "APIError" } })]).pause).toContain("APIError")
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

describe("GoalLoopPlugin", () => {
  let dir: string
  let messages: { info: Message; parts: Part[] }[]
  let prompts: { path: { id: string }; body: any }[]
  let checks: CheckResult[]
  let checkCalls: number

  const client = {
    tui: { showToast: async () => ({ data: true }) },
    session: {
      messages: async () => ({ data: messages }),
      promptAsync: async (input: { path: { id: string }; body: any }) => {
        prompts.push(input)
        return { data: undefined }
      },
    },
  }

  const plugin = (options: { now?: () => number } = {}) =>
    GoalLoopPlugin({ client, directory: dir } as unknown as PluginInput, {
      stateDir: dir,
      now: options.now ?? (() => 1_000),
      runCheck: async () => {
        checkCalls++
        return checks.shift() ?? { code: 1, output: "still failing" }
      },
    })

  const load = async () => JSON.parse(await fs.readFile(path.join(dir, `${SESSION}.json`), "utf8")) as GoalState

  const run = async (hooks: Awaited<ReturnType<typeof plugin>>, args: string) => {
    const output = { parts: [{ type: "text", text: `[goal-loop] ${args}` }] as unknown as Part[] }
    const cfg = {} as Config
    await hooks.config?.(cfg)
    await hooks["command.execute.before"]?.({ command: "goal", sessionID: SESSION, arguments: args }, output)
    return (output.parts[0] as { text: string }).text
  }

  const idle = (hooks: Awaited<ReturnType<typeof plugin>>) =>
    hooks.event?.({ event: { type: "session.idle", properties: { sessionID: SESSION } } as any })

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "goal-loop-"))
    messages = [user(), assistant({ text: "Did a step." })]
    prompts = []
    checks = []
    checkCalls = 0
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("adds /goal, but leaves a person's own /goal alone", async () => {
    const cfg = {} as Config
    await (await plugin()).config?.(cfg)
    expect(cfg.command?.goal?.template).toContain("$ARGUMENTS")

    const own = { command: { goal: { template: "mine" } } } as unknown as Config
    const hooks = await plugin()
    await hooks.config?.(own)
    expect(own.command?.goal?.template).toBe("mine")
    const output = { parts: [{ type: "text", text: "mine" }] as unknown as Part[] }
    await hooks["command.execute.before"]?.({ command: "goal", sessionID: SESSION, arguments: "stop" }, output)
    expect((output.parts[0] as { text: string }).text).toBe("mine")
  })

  test("start runs a baseline check, saves the loop and rewrites the prompt", async () => {
    checks = [{ code: 1, output: "2 fail" }]
    const text = await run(await plugin(), 'parser tests pass --check "bun test" --turns 3')
    expect(text).toContain("A goal loop has started")
    expect(text).toContain("2 fail")
    expect(await load()).toMatchObject({
      status: "active",
      turns: 0,
      maxTurns: 3,
      check: "bun test",
      lastFailure: "2 fail",
    })
  })

  test("start does not loop when the check already passes", async () => {
    checks = [{ code: 0, output: "" }]
    const text = await run(await plugin(), 'parser tests pass --check "bun test"')
    expect(text).toContain("already passes")
    expect((await load()).status).toBe("stopped")
  })

  test("a bad /goal explains the usage and saves nothing", async () => {
    const text = await run(await plugin(), "be better")
    expect(text).toContain("did not start")
    expect(await fs.readdir(dir)).toEqual([])
  })

  test("idle with a failing check sends one continue prompt in the same agent and model", async () => {
    const hooks = await plugin()
    await run(hooks, 'parser tests pass --check "bun test"')
    checks = [{ code: 1, output: "1 fail" }]
    await idle(hooks)
    expect(prompts).toHaveLength(1)
    expect(prompts[0].body.agent).toBe("build")
    expect(prompts[0].body.model).toEqual({ providerID: "synapse", modelID: "auto" })
    expect(prompts[0].body.parts[0].text).toContain("Turn 1/20")
    expect((await load()).turns).toBe(1)
  })

  test("idle with a passing check stops with GOAL_MET and only posts a note", async () => {
    const hooks = await plugin()
    await run(hooks, 'parser tests pass --check "bun test"')
    checks = [{ code: 0, output: "all pass" }]
    await idle(hooks)
    expect((await load()).reason).toStartWith("GOAL_MET")
    expect(prompts).toHaveLength(1)
    expect(prompts[0].body.noReply).toBe(true)
  })

  test("a user abort pauses without running the check, and resume carries on", async () => {
    const hooks = await plugin()
    await run(hooks, 'parser tests pass --check "bun test"')
    const before = checkCalls
    messages = [user(), assistant({ error: { name: "MessageAbortedError" } })]
    await idle(hooks)
    expect(checkCalls).toBe(before)
    expect((await load()).status).toBe("paused")

    const text = await run(hooks, "resume")
    expect(text).toContain("The goal is not met yet")
    expect((await load()).status).toBe("active")
  })

  test("the loop stops after the turn budget", async () => {
    const hooks = await plugin()
    await run(hooks, 'parser tests pass --check "bun test" --turns 2')
    for (const output of ["a", "b", "c"]) {
      checks = [{ code: 1, output }]
      await idle(hooks)
    }
    expect(prompts.filter((p) => !p.body.noReply)).toHaveLength(2)
    expect((await load()).reason).toStartWith("BUDGET_EXHAUSTED")
  })

  test("the loop stops when the check fails the same way three times", async () => {
    const hooks = await plugin()
    await run(hooks, 'parser tests pass --check "bun test"')
    for (let i = 0; i < 4; i++) {
      checks = [{ code: 1, output: "still failing" }]
      await idle(hooks)
    }
    expect((await load()).reason).toStartWith("STALLED")
  })

  test("/goal stop while the check runs means no continue prompt", async () => {
    const hooks = await plugin()
    await run(hooks, 'parser tests pass --check "bun test"')
    const stopping = GoalLoopPlugin({ client, directory: dir } as unknown as PluginInput, {
      stateDir: dir,
      runCheck: async () => {
        await run(hooks, "stop")
        return { code: 1, output: "x" }
      },
    })
    await idle(await stopping)
    expect(prompts).toHaveLength(0)
    expect((await load()).status).toBe("stopped")
  })

  test("a state change saved while the check runs is what the loop decides from", async () => {
    const hooks = await plugin()
    await run(hooks, 'parser tests pass --check "bun test"')
    const changing = GoalLoopPlugin({ client, directory: dir } as unknown as PluginInput, {
      stateDir: dir,
      now: () => 1_000,
      runCheck: async () => {
        await fs.writeFile(path.join(dir, `${SESSION}.json`), JSON.stringify({ ...(await load()), maxTurns: 0 }))
        return { code: 1, output: "x" }
      },
    })
    await idle(await changing)
    expect(prompts).toHaveLength(1)
    expect(prompts[0].body.noReply).toBe(true)
    expect(await load()).toMatchObject({ status: "stopped", maxTurns: 0 })
    expect((await load()).reason).toStartWith("BUDGET_EXHAUSTED")
  })

  test("/goal stop that lands as the check finishes wins over the continue prompt", async () => {
    let calls = 0
    let stopping: Promise<void> | undefined
    const hooks: Awaited<ReturnType<typeof plugin>> = await GoalLoopPlugin(
      { client, directory: dir } as unknown as PluginInput,
      {
        stateDir: dir,
        now: () => 1_000,
        runCheck: async () => {
          calls++
          if (calls === 1) return { code: 1, output: "baseline" }
          // Fire stop without awaiting it, then let the check finish straight away.
          stopping = hooks["command.execute.before"]?.(
            { command: "goal", sessionID: SESSION, arguments: "stop" },
            { parts: [{ type: "text", text: "" }] as unknown as Part[] },
          )
          return { code: 1, output: "x" }
        },
      },
    )
    await run(hooks, 'parser tests pass --check "bun test"')
    await idle(hooks)
    await stopping
    expect(prompts).toHaveLength(0)
    expect((await load()).status).toBe("stopped")
  })

  test("idle does nothing when no loop is active", async () => {
    await idle(await plugin())
    expect(prompts).toHaveLength(0)
    expect(checkCalls).toBe(0)
  })

  test("deleting the session removes its loop", async () => {
    const hooks = await plugin()
    await run(hooks, 'parser tests pass --check "bun test"')
    await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: SESSION } } } as any })
    expect(await fs.readdir(dir)).toEqual([])
  })

  test("the real check runner reports the exit code and stops a slow check", async () => {
    const hooks = await GoalLoopPlugin({ client, directory: dir } as unknown as PluginInput, { stateDir: dir })
    const output = { parts: [{ type: "text", text: "" }] as unknown as Part[] }
    await hooks.config?.({} as Config)
    await hooks["command.execute.before"]?.(
      { command: "goal", sessionID: SESSION, arguments: `exit three --check "bun -e 'process.exit(3)'"` },
      output,
    )
    expect((output.parts[0] as { text: string }).text).toContain("exit 3")

    const started = Date.now()
    await hooks["command.execute.before"]?.(
      {
        command: "goal",
        sessionID: SESSION,
        arguments: `slow --check "bun -e 'setTimeout(()=>{},20000)'" --timeout 1`,
      },
      output,
    )
    expect((output.parts[0] as { text: string }).text).toContain("stopped after 1 seconds")
    // The whole process tree is stopped, so the 20 second child does not hold the check open.
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 30_000)
})
