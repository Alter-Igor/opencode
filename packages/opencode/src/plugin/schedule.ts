import fs from "fs/promises"
import path from "path"
import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { SCHEDULE_COMMAND, SCHEDULE_USAGE, describeSchedules, formatInterval, parseInterval, parseScheduleArgs } from "./schedule-args"
import { childTickStatus, factsLine, shouldSendTick, skipToast } from "./tick-guard"

export { SCHEDULE_COMMAND, parseInterval, parseScheduleArgs }

// Fork-ported from upstream session-schedule (705c3ab746).

const MAX_TIMEOUT_MS = 2_147_483_647

export type ScheduleInfo = {
  version: 1
  id: string
  directory?: string
  sessionID: string
  prompt: string
  next: number
  every?: number
  createdAt: number
}

let counter = 0

function createScheduleID(now: number) {
  counter = (counter + 1) % 1_000_000
  return `sch_${now.toString(36)}_${counter.toString(36).padStart(4, "0")}`
}

export async function SchedulePlugin(
  input: PluginInput,
  options?: { stateDir?: string; now?: () => number },
): Promise<Hooks> {
  const dir = options?.stateDir ?? path.join(Global.Path.state, "schedule")
  const now = options?.now ?? Date.now
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const locks = new Map<string, Promise<unknown>>()
  // exclusive() would run a second fire after this one and write another user row.
  const firing = new Set<string>()
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

  const fire = (id: string) => {
    if (firing.has(id)) return
    firing.add(id)
    return exclusive(id, async () => {
      if (disposed) return
      const current = await load(id)
      if (!current) return
      if (current.next > now()) {
        arm(current)
        return
      }

      const [loaded, statusResult, childrenResult] = await Promise.all([
        input.client.session.messages({ path: { id: current.sessionID } }).catch(() => undefined),
        input.client.session.status().catch(() => undefined),
        input.client.session.children({ path: { id: current.sessionID } }).catch(() => undefined),
      ])
      const statusMap = statusResult?.data ?? {}
      const raw = statusMap[current.sessionID]
      const status = raw?.type === "busy" ? "busy" : raw?.type === "retry" ? "retry" : "idle"
      const children = (childrenResult?.data ?? []).map((child) => ({
        id: child.id,
        status: childTickStatus(statusMap[child.id]),
      }))
      const decision = shouldSendTick({ status, messages: loaded?.data ?? [] })
      if (!decision.send && input.client.tui?.showToast) {
        await input.client.tui
          .showToast({
            body: {
              title: "Schedule",
              message: skipToast(decision.reason, children),
              variant: "warning",
            },
          })
          .catch(() => undefined)
      }
      const user = loaded?.data?.findLast((message) => message.info.role === "user")?.info
      const delivered = decision.send
        ? await input.client.session
            .promptAsync({
              path: { id: current.sessionID },
              body: {
                ...(user?.role === "user" ? { agent: user.agent, model: user.model } : {}),
                parts: [{ type: "text", text: `${factsLine({ status, children })}\n${current.prompt}` }],
              },
            })
            .then(
              (res) => !res || !("error" in res) || !res.error,
              () => false,
            )
        : false

      if (disposed) return
      const latest = await load(id)
      if (!latest || latest.createdAt !== current.createdAt) return
      if (!current.every) {
        if (delivered) {
          await remove(id)
          return
        }
        const retry: ScheduleInfo = {
          ...latest,
          next: now() + 30_000,
        }
        await save(retry)
        arm(retry)
        return
      }
      const updated: ScheduleInfo = {
        ...latest,
        next: Math.max(current.next + current.every, now() + current.every),
      }
      await save(updated)
      arm(updated)
    }).finally(() => {
      firing.delete(id)
    })
  }

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
      directory: input.directory,
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
    if (item.directory && item.directory !== input.directory) continue
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
