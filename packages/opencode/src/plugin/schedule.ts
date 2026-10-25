import fs from "fs/promises"
import path from "path"
import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"

// Fork-ported from upstream session-schedule (705c3ab746): `/schedule` and the
// `schedule_create`, `schedule_list`, `schedule_cancel` tools let sessions and
// subagents schedule recurring or one-shot prompts.

export const SCHEDULE_COMMAND = "schedule"
export const SCHEDULE_USAGE =
  "/schedule <30s|15m|2h|1d> <prompt>  |  /schedule status  |  /schedule off"

const MAX_TIMEOUT_MS = 2_147_483_647

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60 * 1_000,
  h: 60 * 60 * 1_000,
  d: 24 * 60 * 60 * 1_000,
}

export type ScheduleInfo = {
  version: 1
  id: string
  sessionID: string
  prompt: string
  next: number
  every?: number
  createdAt: number
}

export type ScheduleCommandArgs =
  | { action: "status" }
  | { action: "off" }
  | { action: "create"; interval: string; every: number; prompt: string }
  | { action: "error"; message: string }

let counter = 0

function createScheduleID(now: number) {
  counter = (counter + 1) % 1_000_000
  return `sch_${now.toString(36)}_${counter.toString(36).padStart(4, "0")}`
}

export function parseInterval(input: string): number | undefined {
  const match = input.trim().match(/^(\d+)([smhd])$/)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isInteger(value) || value <= 0) return undefined
  const unit = UNITS[match[2]]
  if (!unit) return undefined
  return value * unit
}

export function parseScheduleArgs(text: string): ScheduleCommandArgs {
  const trimmed = text.trim()
  if (!trimmed) return { action: "status" }
  const lower = trimmed.toLowerCase()
  if (lower === "status" || lower === "list") return { action: "status" }
  if (lower === "off" || lower === "stop" || lower === "cancel") return { action: "off" }

  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/)
  if (!match) return { action: "error", message: `Expected ${SCHEDULE_USAGE}` }
  const interval = match[1]
  const every = parseInterval(interval)
  if (!every) {
    return {
      action: "error",
      message: `Invalid schedule interval "${interval}". Use formats like 30s, 15m, 2h, or 1d, or /schedule off.`,
    }
  }
  const prompt = (match[2] ?? "").trim()
  if (!prompt) {
    return {
      action: "error",
      message: `Give a prompt after ${interval}. Usage: ${SCHEDULE_USAGE}`,
    }
  }
  return { action: "create", interval, every, prompt }
}

export function describeSchedules(schedules: ScheduleInfo[], now: number) {
  if (!schedules.length) return "No schedules are active in this session."
  return [
    `Active schedules (${schedules.length}) at ${new Date(now).toISOString()}:`,
    ...schedules.map(
      (item) =>
        `- ${item.id}: next at ${new Date(item.next).toISOString()}${item.every ? ` (every ${formatInterval(item.every)})` : " (one-shot)"} — ${item.prompt}`,
    ),
  ].join("\n")
}

function formatInterval(ms: number) {
  if (ms % UNITS.d === 0) return `${ms / UNITS.d}d`
  if (ms % UNITS.h === 0) return `${ms / UNITS.h}h`
  if (ms % UNITS.m === 0) return `${ms / UNITS.m}m`
  if (ms % UNITS.s === 0) return `${ms / UNITS.s}s`
  return `${ms}ms`
}

export async function SchedulePlugin(
  input: PluginInput,
  options?: { stateDir?: string; now?: () => number },
): Promise<Hooks> {
  const dir = options?.stateDir ?? path.join(Global.Path.state, "schedule")
  const now = options?.now ?? Date.now
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const locks = new Map<string, Promise<unknown>>()
  let owned = false
  let disposed = false

  const file = (id: string) => path.join(dir, `${id.replace(/[^\w.-]/g, "_")}.json`)
  const load = (id: string) =>
    Filesystem.readJson<ScheduleInfo>(file(id)).catch((): ScheduleInfo | undefined => undefined)
  const save = (info: ScheduleInfo) => Filesystem.writeJson(file(info.id), info)

  const exclusive = <T>(key: string, fn: () => Promise<T>) => {
    const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn)
    locks.set(
      key,
      run.catch(() => undefined),
    )
    return run
  }

  const stopTimer = (id: string) => {
    const timer = timers.get(id)
    if (!timer) return
    clearTimeout(timer)
    timers.delete(id)
  }

  const remove = async (id: string) => {
    stopTimer(id)
    await fs.rm(file(id), { force: true }).catch(() => undefined)
  }

  const listAll = async (): Promise<ScheduleInfo[]> => {
    const entries = await fs.readdir(dir).catch((): string[] => [])
    const loaded = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map((name) => Filesystem.readJson<ScheduleInfo>(path.join(dir, name)).catch((): undefined => undefined)),
    )
    return loaded
      .filter((item): item is ScheduleInfo => Boolean(item && typeof item.id === "string" && typeof item.sessionID === "string"))
      .sort((a, b) => a.next - b.next || a.id.localeCompare(b.id))
  }

  const listForSession = async (sessionID: string) => {
    const all = await listAll()
    return all.filter((item) => item.sessionID === sessionID)
  }

  const arm = (info: ScheduleInfo) => {
    stopTimer(info.id)
    if (disposed) return
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, info.next - now()))
    const timer = setTimeout(() => {
      timers.delete(info.id)
      void fire(info.id)
    }, delay)
    timer.unref?.()
    timers.set(info.id, timer)
  }

  const fire = (id: string) =>
    exclusive(id, async () => {
      if (disposed) return
      const current = await load(id)
      if (!current) return
      if (current.next > now()) {
        arm(current)
        return
      }

      const messages = await input.client.session
        .messages({ path: { id: current.sessionID } })
        .catch(() => undefined)
      const user = messages?.data?.findLast((m) => m.info.role === "user")?.info
      await input.client.session
        .promptAsync({
          path: { id: current.sessionID },
          body: {
            ...(user?.role === "user" ? { agent: user.agent, model: user.model } : {}),
            parts: [{ type: "text", text: current.prompt }],
          },
        })
        .catch(() => undefined)

      if (disposed) return
      const latest = await load(id)
      if (!latest || latest.createdAt !== current.createdAt) return
      if (!current.every) {
        await remove(id)
        return
      }
      const updated: ScheduleInfo = {
        ...latest,
        next: Math.max(current.next + current.every, now() + current.every),
      }
      await save(updated)
      arm(updated)
    })

  const create = async (params: {
    sessionID: string
    prompt: string
    every?: string
    at?: string
  }) => {
    const prompt = params.prompt.trim()
    if (!prompt) throw new Error("Schedule prompt cannot be empty.")

    const everyRaw = params.every?.trim() || undefined
    const atRaw = params.at?.trim() || undefined
    if (!everyRaw && !atRaw) {
      throw new Error("Provide `every`, `at`, or both when creating a schedule.")
    }

    const every = everyRaw ? parseInterval(everyRaw) : undefined
    if (everyRaw && !every) {
      throw new Error(`Invalid interval: ${everyRaw}. Expected formats like 30s, 15m, 2h, or 1d.`)
    }

    const currentNow = now()
    const at = atRaw ? Date.parse(atRaw) : undefined
    if (atRaw && (at === undefined || !Number.isFinite(at))) {
      throw new Error(`Invalid timestamp: ${atRaw}. Expected an ISO-8601 timestamp.`)
    }
    if (at !== undefined && at <= currentNow) {
      throw new Error(`Scheduled time must be in the future: ${atRaw}`)
    }

    const next = at ?? currentNow + (every ?? 0)
    const info: ScheduleInfo = {
      version: 1,
      id: createScheduleID(currentNow),
      sessionID: params.sessionID,
      prompt,
      next,
      ...(every !== undefined ? { every } : {}),
      createdAt: currentNow,
    }
    await exclusive(info.id, async () => {
      await save(info)
      arm(info)
    })
    return info
  }

  const cancelForSession = async (sessionID: string) => {
    const list = await listForSession(sessionID)
    await Promise.all(list.map((item) => exclusive(item.id, () => remove(item.id))))
    return list.length
  }

  const existing = await listAll()
  for (const item of existing) {
    arm(item)
  }

  return {
    config: async (cfg) => {
      if (cfg.command?.[SCHEDULE_COMMAND]) return
      cfg.command = {
        ...cfg.command,
        [SCHEDULE_COMMAND]: {
          description: "schedule a recurring prompt in this session",
          template: "[schedule] $ARGUMENTS",
        },
      }
      owned = true
    },
    "command.execute.before": async (hook, output) => {
      if (!owned || hook.command !== SCHEDULE_COMMAND) return
      const parsed = parseScheduleArgs(hook.arguments)
      const reply = await (async () => {
        if (parsed.action === "error") {
          return `[schedule] The schedule did not start: ${parsed.message}\nUsage: ${SCHEDULE_USAGE}\nTell the user this in one or two lines. Do no other work.`
        }
        if (parsed.action === "status") {
          const list = await listForSession(hook.sessionID)
          return `[schedule] ${describeSchedules(list, now())}\nTell the user this status in plain words. Do no other work.`
        }
        if (parsed.action === "off") {
          const removed = await cancelForSession(hook.sessionID)
          return `[schedule] ${removed ? `Cancelled ${removed} schedule(s) in this session.` : "No schedules were active in this session."}\nTell the user this in one line. Do no other work.`
        }
        const created = await create({
          sessionID: hook.sessionID,
          prompt: parsed.prompt,
          every: parsed.interval,
        })
        return `[schedule] Scheduled ${created.id} every ${parsed.interval} (next run at ${new Date(created.next).toISOString()}): ${created.prompt}\nConfirm the schedule in one short line. The first scheduled run will happen after ${parsed.interval}, so do not execute the scheduled task right now unless the user asked you to run it immediately.`
      })()
      const text = output.parts.find((part) => part.type === "text")
      if (text?.type === "text") text.text = reply
    },
    tool: {
      schedule_create: tool({
        description:
          "Create a scheduled prompt for the current session (or a target session). Provide `every` for a repeating interval (`30s`, `15m`, `2h`, `1d`), `at` for an ISO-8601 timestamp, or both (`at` sets the first run, `every` repeats after that).",
        args: {
          prompt: tool.schema.string().describe("Prompt text to send when the schedule fires"),
          every: tool.schema
            .string()
            .optional()
            .describe("Repeating interval using s, m, h, or d (for example: 30s, 15m, 2h, 1d)"),
          at: tool.schema.string().optional().describe("First run time as an ISO-8601 timestamp"),
          session_id: tool.schema
            .string()
            .optional()
            .describe("Optional session ID to schedule for (defaults to the current session)"),
        },
        async execute(args, context) {
          const targetSession = args.session_id?.trim() || context.sessionID
          const info = await create({
            sessionID: targetSession,
            prompt: args.prompt,
            every: args.every,
            at: args.at,
          })
          context.metadata({
            title: "Created schedule",
            metadata: {
              scheduleId: info.id,
              sessionID: info.sessionID,
              next: info.next,
              every: info.every,
            },
          })
          return `Created schedule ${info.id} for session ${info.sessionID}: next run at ${new Date(info.next).toISOString()}${info.every ? ` (every ${formatInterval(info.every)})` : " (one-shot)"}.`
        },
      }),
      schedule_list: tool({
        description: "List active scheduled prompts for the current session (or a target session).",
        args: {
          session_id: tool.schema
            .string()
            .optional()
            .describe("Optional session ID to list schedules for (defaults to the current session)"),
        },
        async execute(args, context) {
          const targetSession = args.session_id?.trim() || context.sessionID
          const list = await listForSession(targetSession)
          context.metadata({
            title: "Listed schedules",
            metadata: {
              sessionID: targetSession,
              count: list.length,
            },
          })
          return JSON.stringify(
            {
              now: new Date(now()).toISOString(),
              schedules: list.map((item) => ({
                id: item.id,
                sessionID: item.sessionID,
                prompt: item.prompt,
                next: new Date(item.next).toISOString(),
                every: item.every,
              })),
            },
            null,
            2,
          )
        },
      }),
      schedule_cancel: tool({
        description: "Cancel a scheduled prompt by ID (or pass `all` to cancel every schedule in the session).",
        args: {
          id: tool.schema
            .string()
            .describe("Schedule ID to cancel, or 'all' to cancel all schedules in the session"),
          session_id: tool.schema
            .string()
            .optional()
            .describe("Optional session ID owning the schedule (defaults to the current session)"),
        },
        async execute(args, context) {
          const targetSession = args.session_id?.trim() || context.sessionID
          const id = args.id.trim()
          if (id.toLowerCase() === "all") {
            const count = await cancelForSession(targetSession)
            context.metadata({
              title: "Cancelled schedules",
              metadata: { sessionID: targetSession, cancelled: count },
            })
            return `Cancelled ${count} schedule(s) for session ${targetSession}.`
          }
          const current = await load(id)
          if (!current || current.sessionID !== targetSession) {
            throw new Error(`Schedule not found: ${id}`)
          }
          await exclusive(id, () => remove(id))
          context.metadata({
            title: "Cancelled schedule",
            metadata: { scheduleId: current.id, sessionID: current.sessionID },
          })
          return `Cancelled schedule ${current.id}: ${current.prompt}`
        },
      }),
    },
    event: async ({ event }) => {
      if (event.type !== "session.deleted") return
      await cancelForSession(event.properties.info.id)
    },
    dispose: async () => {
      disposed = true
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      timers.clear()
    },
  }
}
