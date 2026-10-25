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
  let activeHooks: Awaited<ReturnType<typeof SchedulePlugin>> | undefined

  const client = {
    session: {
      messages: async () => ({
        data: [
          {
            info: {
              role: "user",
              agent: "general",
              model: { providerID: "synapse", modelID: "auto" },
            } as unknown as Message,
            parts: [] as Part[],
          },
        ],
      }),
      promptAsync: async (req: { path: { id: string }; body: Record<string, unknown> }) => {
        prompts.push({ sessionID: req.path.id, body: req.body })
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
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(prompts).toHaveLength(1)
    expect(prompts[0].sessionID).toBe(SESSION)
    expect(prompts[0].body.agent).toBe("general")
    expect(prompts[0].body.parts).toEqual([{ type: "text", text: "ping once" }])

    const afterFire = JSON.parse(String(await listTool.execute({}, toolCtx()))) as {
      schedules: unknown[]
    }
    expect(afterFire.schedules).toHaveLength(0)
  })

  test("fires a recurring schedule and advances next run time", async () => {
    const hooks = await plugin()
    const createTool = hooks.tool!.schedule_create
    const listTool = hooks.tool!.schedule_list

    await createTool.execute({ prompt: "poll status", every: "1s" }, toolCtx())
    clock += 1_000
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    expect(prompts.length).toBeGreaterThanOrEqual(1)
    expect(prompts[0].body.parts).toEqual([{ type: "text", text: "poll status" }])

    const afterFirst = JSON.parse(String(await listTool.execute({}, toolCtx()))) as {
      schedules: { id: string; next: string; every?: number }[]
    }
    expect(afterFirst.schedules).toHaveLength(1)
    expect(Date.parse(afterFirst.schedules[0].next)).toBeGreaterThan(clock)
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
})
