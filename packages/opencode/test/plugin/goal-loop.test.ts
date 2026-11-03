import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Config, PluginInput } from "@opencode-ai/plugin"
import type { Event, Message, Part } from "@opencode-ai/sdk"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { GOAL_DEFAULTS, GoalLoopPlugin, type CheckResult, type GoalState } from "../../src/plugin/goal-loop"

const SESSION = "ses_goal_test"

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

describe("GoalLoopPlugin", () => {
  let dir: string
  let messages: { info: Message; parts: Part[] }[]
  let prompts: { path: { id: string }; body: any }[]
  let checks: CheckResult[]
  let checkCalls: number
  let toasts: { title?: string; message?: string }[]

  const client = {
    tui: {
      showToast: async (input: { body?: { title?: string; message?: string } }) => {
        toasts.push({ title: input.body?.title, message: input.body?.message })
        return { data: true }
      },
    },
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
    hooks.event?.({ event: { type: "session.idle", properties: { sessionID: SESSION } } as Event })

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "goal-loop-"))
    messages = [user(), assistant({ text: "Did a step." })]
    prompts = []
    checks = []
    checkCalls = 0
    toasts = []
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

  test("a failed reply is retried through the continue path, and a good reply resets the count (#327)", async () => {
    const hooks = await plugin()
    await run(hooks, 'parser tests pass --check "bun test"')
    messages = [user(), assistant({ error: { name: "UnknownError", message: "gpu busy" } })]
    await idle(hooks)
    expect((await load()).status).toBe("active")
    expect((await load()).turnErrors).toBe(1)
    expect(prompts.filter((p) => !p.body.noReply)).toHaveLength(1)
    expect(prompts.some((p) => p.body.noReply && p.body.parts[0].text.includes("retrying (1 of 2)"))).toBe(true)

    messages = [user(), assistant({ text: "Wrote the test." })]
    await idle(hooks)
    expect((await load()).turnErrors).toBe(0)
  })

  test("failed replies past the retry budget pause and name the error (#327)", async () => {
    const hooks = await plugin()
    await run(hooks, 'parser tests pass --check "bun test"')
    messages = [user(), assistant({ error: { name: "UnknownError", message: "gpu busy" } })]
    for (let i = 0; i < GOAL_DEFAULTS.turnRetries; i++) await idle(hooks)
    expect((await load()).status).toBe("active")
    const before = checkCalls
    await idle(hooks)
    const state = await load()
    expect(state.status).toBe("paused")
    expect(state.reason).toBe(`the turn failed (UnknownError: gpu busy) ${GOAL_DEFAULTS.turnRetries + 1} times in a row`)
    expect(checkCalls).toBe(before)

    const text = await run(hooks, "resume")
    expect(text).toContain("The goal is not met yet")
    expect((await load()).turnErrors).toBe(0)
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

  test("idle does not continue when a real user message is still unanswered", async () => {
    const hooks = await plugin()
    await run(hooks, 'parser tests pass --check "bun test"')
    messages = [
      {
        info: {
          role: "user",
          agent: "build",
          model: { providerID: "synapse", modelID: "auto" },
        } as unknown as Message,
        parts: [{ type: "text", text: "please look at this" }] as unknown as Part[],
      },
    ]
    checks = [{ code: 1, output: "1 fail" }]
    await idle(hooks)
    expect(prompts).toHaveLength(0)
    expect(toasts.some((toast) => toast.title === "Goal loop" && toast.message?.includes("still waiting"))).toBe(true)
  })

  test("idle does nothing when no loop is active", async () => {
    await idle(await plugin())
    expect(prompts).toHaveLength(0)
    expect(checkCalls).toBe(0)
  })

  test("deleting the session removes its loop", async () => {
    const hooks = await plugin()
    await run(hooks, 'parser tests pass --check "bun test"')
    await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: SESSION } } } as Event })
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

  test("goal_loop tool starts, inspects, and stops a session goal loop", async () => {
    const hooks = await plugin()
    const goalTool = hooks.tool?.goal_loop
    expect(goalTool).toBeDefined()
    const ctx = {
      sessionID: SESSION,
      messageID: "msg_1",
      agent: "general",
      directory: dir,
      worktree: dir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    }

    const startReply = await goalTool!.execute(
      { action: "start", goal: "subagent tests pass", check: "bun test", turns: 4 },
      ctx,
    )
    expect(startReply).toContain("A goal loop has started for this session.")
    expect((await load()).status).toBe("active")
    expect((await load()).maxTurns).toBe(4)

    const statusReply = await goalTool!.execute({ action: "status" }, ctx)
    expect(statusReply).toContain("Goal loop: active")

    const stopReply = await goalTool!.execute({ action: "stop" }, ctx)
    expect(stopReply).toContain("The goal loop is stopped.")
    expect((await load()).status).toBe("stopped")
  })
})
