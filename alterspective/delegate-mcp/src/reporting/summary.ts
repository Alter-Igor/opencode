// #73: the report maths behind oc_report. Pure functions over task records: counts by outcome,
// success rate = completed / finished (completed + error + aborted + unknown after a send), median and p90 (nearest rank)
// of first-send-to-finish durations, and what happened to each task's work.
import type { TaskRecord } from "./record.ts"
import { mainServedModel } from "./served.ts"

/** `servedModel` (#76): the model Synapse served most of a task's calls; `model` is the one sent. */
export type GroupBy = "model" | "servedModel" | "agent" | "repo"
export type ReportOptions = { sinceDays: number; groupBy: GroupBy; recent: number; now: number }

export type Durations = { median: number | null; p90: number | null; samples: number }
export type Dispositions = { collected: number; closedDiscarded: number; open: number; closedClean: number; swept: number }
export type Metrics = {
  tasks: number
  completed: number
  error: number
  aborted: number
  running: number
  /** Includes `notSent`. */
  unknown: number
  /** Started but never sent a prompt: not a run, so not in `finished`. */
  notSent: number
  /** completed + error + aborted + unknown (excluding notSent). */
  finished: number
  /** completed / finished, 0..1; null when nothing has finished. */
  successRate: number | null
  durationMs: Durations
  dispositions: Dispositions
}
export type Group = Metrics & { name: string }
export type Report = { since: string; totals: Metrics; groups: Group[]; recent: TaskRecord[] }

const DAY_MS = 24 * 60 * 60 * 1000
export const UNKNOWN_GROUP = "(unknown)"

/** Middle value; the mean of the two middle values for an even count. */
export function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Nearest-rank percentile: the smallest value with at least p% of values at or below it. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[Math.min(rank, sorted.length) - 1]
}

function metrics(records: readonly TaskRecord[]): Metrics {
  const by = (outcome: TaskRecord["outcome"]) => records.filter((r) => r.outcome === outcome).length
  const completed = by("completed")
  const error = by("error")
  const aborted = by("aborted")
  // Review cycle 1 (MEDIUM 1): unknown counts as finished (a run that was closed or lost without a
  // settled state), so it lowers the success rate and never raises it. A task never sent is not a run.
  const isFinished = (r: TaskRecord) => r.outcome === "completed" || r.outcome === "error" || r.outcome === "aborted" || (r.outcome === "unknown" && r.sendCount > 0)
  const finished = records.filter(isFinished).length
  const durations = records.filter((r) => isFinished(r) && r.durationMs !== undefined).map((r) => r.durationMs as number)
  // Each task counts once: collected work first, then what happened to the rest.
  const notCollected = records.filter((r) => !r.collected)
  const disposed = (d: TaskRecord["disposition"]) => notCollected.filter((r) => r.disposition === d).length
  return {
    tasks: records.length,
    completed,
    error,
    aborted,
    running: by("running"),
    unknown: by("unknown"),
    notSent: records.filter((r) => r.outcome === "unknown" && r.sendCount === 0).length,
    finished,
    successRate: finished ? completed / finished : null,
    durationMs: { median: median(durations) ?? null, p90: percentile(durations, 90) ?? null, samples: durations.length },
    dispositions: {
      collected: records.length - notCollected.length,
      closedDiscarded: disposed("closed_discarded"),
      open: disposed("open") + disposed("collected"),
      closedClean: disposed("closed_clean"),
      swept: disposed("swept"),
    },
  }
}

function groupName(record: TaskRecord, groupBy: GroupBy): string {
  if (groupBy === "model") return record.requestedModel ?? UNKNOWN_GROUP
  if (groupBy === "servedModel") return mainServedModel(record.servedModels) ?? UNKNOWN_GROUP
  if (groupBy === "agent") return record.agent ?? UNKNOWN_GROUP
  return record.repo
}

export function summarise(records: readonly TaskRecord[], options: ReportOptions): Report {
  const since = options.now - options.sinceDays * DAY_MS
  const inWindow = records.filter((r) => Date.parse(r.startedAt) >= since).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.key.localeCompare(b.key))
  const buckets = new Map<string, TaskRecord[]>()
  for (const r of inWindow) {
    const name = groupName(r, options.groupBy)
    buckets.set(name, [...(buckets.get(name) ?? []), r])
  }
  const groups = [...buckets.entries()].map(([name, list]) => ({ name, ...metrics(list) })).sort((a, b) => b.tasks - a.tasks || a.name.localeCompare(b.name))
  return { since: new Date(since).toISOString(), totals: metrics(inWindow), groups, recent: inWindow.slice(0, Math.max(0, options.recent)) }
}
