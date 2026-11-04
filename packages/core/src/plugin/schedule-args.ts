export const SCHEDULE_COMMAND = "schedule"
export const SCHEDULE_USAGE =
  "/schedule <30s|15m|2h|1d> <prompt>  |  /schedule status  |  /schedule off"

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60 * 1_000,
  h: 60 * 60 * 1_000,
  d: 24 * 60 * 60 * 1_000,
}

export type ScheduleCommandArgs =
  | { action: "status" }
  | { action: "off" }
  | { action: "create"; interval: string; every: number; prompt: string }
  | { action: "error"; message: string }

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

export function formatInterval(ms: number) {
  if (ms % UNITS.d === 0) return `${ms / UNITS.d}d`
  if (ms % UNITS.h === 0) return `${ms / UNITS.h}h`
  if (ms % UNITS.m === 0) return `${ms / UNITS.m}m`
  if (ms % UNITS.s === 0) return `${ms / UNITS.s}s`
  return `${ms}ms`
}

export function describeSchedules(
  schedules: { id: string; next: number; every?: number; prompt: string }[],
  now: number,
) {
  if (!schedules.length) return "No schedules are active in this session."
  return [
    `Active schedules (${schedules.length}) at ${new Date(now).toISOString()}:`,
    ...schedules.map(
      (item) =>
        `- ${item.id}: next at ${new Date(item.next).toISOString()}${item.every ? ` (every ${formatInterval(item.every)})` : " (one-shot)"} — ${item.prompt}`,
    ),
  ].join("\n")
}
