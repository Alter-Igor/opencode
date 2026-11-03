import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Config, PluginInput, ToolContext } from "@opencode-ai/plugin"
import type { Message, Part } from "@opencode-ai/sdk"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  SCHEDULE_COMMAND,
  SchedulePlugin,
  parseInterval,
  parseScheduleArgs,
} from "../../src/plugin/schedule"

const SESSION = "ses_schedule_test"

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error("waitFor timed out")
}

const IDLE_TICK = "[tick] status=idle children=0 working, 0 idle, 0 failed"

function userRow(text = "hello") {
  return {
    info: {
      role: "user",
      agent: "general",
      model: { providerID: "synapse", modelID: "auto" },
    } as unknown as Message,
    parts: [{ type: "text", text }] as unknown as Part[],
  }
}

function assistantRow() {
  return {
    info: { role: "assistant" } as unknown as Message,
    parts: [{ type: "text", text: "done" }] as unknown as Part[],
  }
}

function toolCtx(sessionID = SESSION): ToolContext {
  return {
    sessionID,
    messageID: "msg_1",
    agent: "general",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

describe("parseInterval", () => {
  test("parses seconds, minutes, hours, and days", () => {
    expect(parseInterval("30s")).toBe(30_000)
    expect(parseInterval("15m")).toBe(15 * 60_000)
    expect(parseInterval("2h")).toBe(2 * 60 * 60_000)
    expect(parseInterval("1d")).toBe(24 * 60 * 60_000)
  })

  test("rejects zero, negative, fractional, and unknown units", () => {
    expect(parseInterval("")).toBeUndefined()
    expect(parseInterval("0s")).toBeUndefined()
    expect(parseInterval("-5m")).toBeUndefined()
    expect(parseInterval("1.5h")).toBeUndefined()
    expect(parseInterval("10w")).toBeUndefined()
    expect(parseInterval("abc")).toBeUndefined()
  })
})

describe("parseScheduleArgs", () => {
  test("parses status, off, and interval + prompt", () => {
    expect(parseScheduleArgs("")).toEqual({ action: "status" })
    expect(parseScheduleArgs("status")).toEqual({ action: "status" })
    expect(parseScheduleArgs("off")).toEqual({ action: "off" })
    expect(parseScheduleArgs("15m check build health")).toEqual({
      action: "create",
      interval: "15m",
      every: 15 * 60_000,
      prompt: "check build health",
    })
  })

  test("reports errors for bad interval or missing prompt", () => {
    expect(parseScheduleArgs("10w run check").action).toBe("error")
    expect(parseScheduleArgs("15m").action).toBe("error")
  })
})

describe("SchedulePlugin", () => {
  let dir = ""
  let clock = 1_700_000_000_000
  let prompts: { sessionID: string; body: Record<string, unknown> }[] = []
  let rows = [userRow(), assistantRow()]
  let statuses: Record<string, { type: string; error?: string }> = {}
  let children: { id: string }[] = []
  let toasts: { title?: string; message?: string }[] = []
  let holdPrompt: Promise<void> | undefined
  let activeHooks: Awaited<ReturnType<typeof SchedulePlugin>> | undefined

  const client = {
    tui: {
      showToast: async (req: { body?: { title?: string; message?: string } }) => {
        toasts.push({ title: req.body?.title, message: req.body?.message })
        return { data: true }
      },
    },
    session: {
      messages: async () => ({ data: rows }),
      status: async () => ({ data: statuses }),
      children: async () => ({ data: children }),
      promptAsync: async (req: { path: { id: string }; body: Record<string, unknown> }) => {
        prompts.push({ sessionID: req.path.id, body: req.body })
        if (holdPrompt) await holdPrompt
        return { data: undefined }
      },
    },
  }

  const plugin = async () => {
    const hooks = await SchedulePlugin({ client, directory: dir } as unknown as PluginInput, {
      stateDir: dir,
      now: () => clock,
    })
    activeHooks = hooks
    return hooks
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-schedule-"))
    clock = 1_700_000_000_000
    prompts = []
    rows = [userRow(), assistantRow()]
    statuses = {}
    children = []
    toasts = []
    holdPrompt = undefined
    activeHooks = undefined
  })

  afterEach(async () => {
    await activeHooks?.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("registers /schedule command unless user config already defines one", async () => {
    const hooks = await plugin()
    const cfg = {} as Config
    await hooks.config?.(cfg)
    expect(cfg.command?.[SCHEDULE_COMMAND]?.template).toContain("$ARGUMENTS")

    const custom = { command: { [SCHEDULE_COMMAND]: { template: "custom" } } } as unknown as Config
    const hooks2 = await plugin()
    await hooks2.config?.(custom)
    expect(custom.command?.[SCHEDULE_COMMAND]?.template).toBe("custom")
  })

  test("schedule_create, schedule_list, and schedule_cancel manage session schedules", async () => {
    const hooks = await plugin()
    const createTool = hooks.tool?.schedule_create
    const listTool = hooks.tool?.schedule_list
    const cancelTool = hooks.tool?.schedule_cancel
    expect(createTool).toBeDefined()
    expect(listTool).toBeDefined()
    expect(cancelTool).toBeDefined()

    const createdText = await createTool!.execute(
      { prompt: "run health check", every: "15m" },
      toolCtx(),
    )
    expect(createdText).toContain("Created schedule sch_")
    expect(createdText).toContain("(every 15m)")

    const listedJson = String(await listTool!.execute({}, toolCtx()))
    const listed = JSON.parse(listedJson) as {
      now: string
      schedules: { id: string; sessionID: string; prompt: string; next: string; every?: number }[]
    }
    expect(listed.schedules).toHaveLength(1)
    expect(listed.schedules[0].sessionID).toBe(SESSION)
    expect(listed.schedules[0].prompt).toBe("run health check")
    expect(listed.schedules[0].every).toBe(15 * 60_000)

    const cancelledText = String(await cancelTool!.execute({ id: listed.schedules[0].id }, toolCtx()))
    expect(cancelledText).toContain("Cancelled schedule")

    const afterCancel = JSON.parse(String(await listTool!.execute({}, toolCtx()))) as {
      schedules: unknown[]
    }
    expect(afterCancel.schedules).toHaveLength(0)
  })

  test("fires a one-shot schedule and removes it after firing", async () => {
    const hooks = await plugin()
    const createTool = hooks.tool!.schedule_create
    const listTool = hooks.tool!.schedule_list

    const futureIso = new Date(clock + 20).toISOString()
    await createTool.execute({ prompt: "ping once", at: futureIso }, toolCtx())

    clock += 25
    await waitFor(() => prompts.length === 1)

    expect(prompts).toHaveLength(1)
    expect(prompts[0].sessionID).toBe(SESSION)
    expect(prompts[0].body.agent).toBe("general")
    expect(prompts[0].body.parts).toEqual([{ type: "text", text: `${IDLE_TICK}\nping once` }])
    expect(String((prompts[0].body.parts as { text: string }[])[0].text).startsWith("[tick]")).toBe(true)

    await waitFor(async () => {
      const parsed = JSON.parse(String(await listTool.execute({}, toolCtx()))) as {
        schedules: unknown[]
      }
      return parsed.schedules.length === 0
    })
  })

  test("fires a recurring schedule and advances next run time", async () => {
    const hooks = await plugin()
    const createTool = hooks.tool!.schedule_create
    const listTool = hooks.tool!.schedule_list

    await createTool.execute({ prompt: "poll status", every: "1s" }, toolCtx())
    clock += 1_000
    await waitFor(() => prompts.length >= 1)

    expect(prompts.length).toBeGreaterThanOrEqual(1)
    expect(prompts[0].body.parts).toEqual([{ type: "text", text: `${IDLE_TICK}\npoll status` }])

    await waitFor(async () => {
      const afterFirst = JSON.parse(String(await listTool.execute({}, toolCtx()))) as {
        schedules: { id: string; next: string; every?: number }[]
      }
      return afterFirst.schedules.length === 1 && Date.parse(afterFirst.schedules[0].next) > clock
    })
  })

  test("/schedule command creates and cancels schedules, and session.deleted cleans up", async () => {
    const hooks = await plugin()
    await hooks.config?.({} as Config)
    const output = { parts: [{ type: "text", text: "" }] as unknown as Part[] }

    await hooks["command.execute.before"]?.(
      { command: SCHEDULE_COMMAND, sessionID: SESSION, arguments: "30s check queue" },
      output,
    )
    expect((output.parts[0] as { text: string }).text).toContain("Scheduled sch_")

    await hooks["command.execute.before"]?.(
      { command: SCHEDULE_COMMAND, sessionID: SESSION, arguments: "status" },
      output,
    )
    expect((output.parts[0] as { text: string }).text).toContain("Active schedules (1)")

    await hooks["command.execute.before"]?.(
      { command: SCHEDULE_COMMAND, sessionID: SESSION, arguments: "off" },
      output,
    )
    expect((output.parts[0] as { text: string }).text).toContain("Cancelled 1 schedule(s)")

    await hooks.tool!.schedule_create.execute({ prompt: "cleanup test", every: "1h" }, toolCtx())
    await hooks.event?.({
      event: { type: "session.deleted", properties: { info: { id: SESSION } } } as never,
    })
    const remaining = JSON.parse(String(await hooks.tool!.schedule_list.execute({}, toolCtx()))) as {
      schedules: unknown[]
    }
    expect(remaining.schedules).toHaveLength(0)
  })

  test("does not prompt when the session is busy or retrying", async () => {
    const hooks = await plugin()
    const createTool = hooks.tool!.schedule_create
    const listTool = hooks.tool!.schedule_list
    children = [{ id: "ses_child" }]

    for (const type of ["busy", "retry"]) {
      prompts = []
      toasts = []
      statuses = { [SESSION]: { type }, ses_child: { type: "busy" } }
      const before = clock
      await createTool.execute(
        { prompt: "poll status", every: "15m", at: new Date(clock + 20).toISOString() },
        toolCtx(),
      )
      clock += 25
      await waitFor(() => toasts.length === 1)
      expect(prompts).toHaveLength(0)
      expect(toasts[0]).toEqual({
        title: "Schedule",
        message: "Tick skipped, session busy. Children: 1 working, 0 idle, 0 failed.",
      })
      await waitFor(async () => {
        const listed = JSON.parse(String(await listTool.execute({}, toolCtx()))) as {
          schedules: { next: string }[]
        }
        return listed.schedules.length === 1 && Date.parse(listed.schedules[0].next) > before + 25
      })
      await hooks.tool!.schedule_cancel.execute({ id: "all" }, toolCtx())
    }
  })

  test("does not prompt when the last real user message has no assistant after it", async () => {
    const hooks = await plugin()
    rows = [userRow("still waiting")]
    children = [{ id: "ses_child" }]
    await hooks.tool!.schedule_create.execute({ prompt: "ping once", at: new Date(clock + 20).toISOString() }, toolCtx())
    clock += 25
    await waitFor(() => toasts.length === 1)
    expect(prompts).toHaveLength(0)
    expect(toasts[0]).toEqual({
      title: "Schedule",
      message: "Tick skipped, a message is still waiting. Children: 0 working, 1 idle, 0 failed.",
    })
    await waitFor(async () => {
      const listed = JSON.parse(String(await hooks.tool!.schedule_list.execute({}, toolCtx()))) as {
        schedules: { next: string }[]
      }
      return listed.schedules.length === 1 && Date.parse(listed.schedules[0].next) >= clock + 30_000
    })
  })

  test("a second fire while the first is in flight does not prompt again", async () => {
    const original = globalThis.setTimeout
    let doubled = false
    let release: (() => void) | undefined
    holdPrompt = new Promise<void>((resolve) => {
      release = resolve
    })
    globalThis.setTimeout = ((fn: TimerHandler, delay?: number) => {
      if (!doubled && typeof fn === "function" && delay === 20) {
        doubled = true
        return original(() => {
          fn()
          fn()
        }, delay)
      }
      return original(fn, delay)
    }) as typeof setTimeout

    try {
      const hooks = await plugin()
      await hooks.tool!.schedule_create.execute(
        { prompt: "ping once", at: new Date(clock + 20).toISOString() },
        toolCtx(),
      )
      clock += 25
      await waitFor(() => prompts.length === 1)
      const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"))
      const saved = JSON.parse(await fs.readFile(path.join(dir, names[0]), "utf8")) as { createdAt: number }
      await fs.writeFile(path.join(dir, names[0]), JSON.stringify({ ...saved, createdAt: saved.createdAt + 1 }))
      release?.()
      release = undefined
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(prompts).toHaveLength(1)
      expect(String((prompts[0].body.parts as { text: string }[])[0].text).startsWith("[tick]")).toBe(true)
    } finally {
      globalThis.setTimeout = original
      release?.()
      holdPrompt = undefined
    }
  })
})
