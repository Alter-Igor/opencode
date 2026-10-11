// Per-model scorecard: how well each model actually served delegated work, computed from the
// host-side task records (src/reporting/record.ts) of every bridge sharing this home. A pure
// function over validated records - no clock, no disk, no Docker - so the dashboard, oc_report and
// the outcome exporter all read the same numbers. Metadata only (model ids, outcomes, durations,
// tokens, repo folder names); never a prompt or an error body.
//
// Why share-weighted: Synapse names the model per call (x-served-model), and a task mixes calls
// across models. A task's credit is split by the calls each model served, so a model that carried
// most of a completed task earns most of it. `mainServedModel` is the single label for one row.
import type { TaskRecord } from "./record.ts"
import { mainServedModel } from "./served.ts"
import { median, percentile } from "./summary.ts"

/** A model's rollup. Counts are fractional (share-weighted); round for display. */
export type ModelScore = {
  model: string
  /** Served by this model (true), or only ever requested and re-routed away (requested-only). */
  kind: "served" | "requested-only"
  tasks: number
  completed: number
  error: number
  aborted: number
  unknown: number
  running: number
  /** Fraction done of finished tasks (the summary.ts rule: completed + error + aborted + unknown-after-a-send), 0..1; null when none finished. */
  successRate: number | null
  medianMs: number | null
  p90Ms: number | null
  tokensIn: number
  tokensOut: number
  repos: number
  /** error outcome split by code (a model's failure signature). */
  errorKinds: Record<string, number>
}

export type Scorecard = {
  generatedAt: string
  days: number
  since: string
  tasks: number
  models: ModelScore[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const strip = (model: string) => (model.startsWith("synapse/") ? model.slice("synapse/".length) : model)
const byModel = (a: ModelScore, b: ModelScore) => b.tasks - a.tasks || a.model.localeCompare(b.model)
/** The summary.ts rule: unknown counts as finished only after a send; a running task never is. */
const isFinished = (record: TaskRecord) => record.outcome === "completed" || record.outcome === "error" || record.outcome === "aborted" || (record.outcome === "unknown" && record.sendCount > 0)

/** One task's share of credit for `model`: 0 when it served none of it. */
function servedShare(record: TaskRecord, model: string): number {
  const calls = (record.servedModels ?? {})[model]
  if (calls === undefined) return 0
  const total = Object.values(record.servedModels ?? {}).reduce((a, b) => a + b, 0)
  return total > 0 ? calls / total : 0
}

type Bucket = {
  tasks: number
  completed: number
  error: number
  aborted: number
  unknown: number
  running: number
  finished: number
  durations: number[]
  tokensIn: number
  tokensOut: number
  repos: Set<string>
  errorKinds: Map<string, number>
}
const emptyBucket = (): Bucket => ({ tasks: 0, completed: 0, error: 0, aborted: 0, unknown: 0, running: 0, finished: 0, durations: [], tokensIn: 0, tokensOut: 0, repos: new Set(), errorKinds: new Map() })

function add(bucket: Bucket, record: TaskRecord, share: number): void {
  bucket.tasks += share
  if (isFinished(record)) bucket.finished += share
  if (record.outcome === "completed") bucket.completed += share
  else if (record.outcome === "aborted") bucket.aborted += share
  else if (record.outcome === "error") {
    bucket.error += share
    const code = record.errorCode ?? "other"
    bucket.errorKinds.set(code, (bucket.errorKinds.get(code) ?? 0) + share)
  } else if (record.outcome === "unknown") bucket.unknown += share
  else bucket.running += share
  if (isFinished(record) && record.durationMs !== undefined) bucket.durations.push(record.durationMs)
  bucket.tokensIn += (record.tokens?.input ?? 0) * share
  bucket.tokensOut += (record.tokens?.output ?? 0) * share
  bucket.repos.add(record.repo)
}

function score(model: string, kind: ModelScore["kind"], bucket: Bucket): ModelScore {
  return {
    model,
    kind,
    tasks: bucket.tasks,
    completed: bucket.completed,
    error: bucket.error,
    aborted: bucket.aborted,
    unknown: bucket.unknown,
    running: bucket.running,
    successRate: bucket.finished > 0 ? bucket.completed / bucket.finished : null,
    medianMs: median(bucket.durations) ?? null,
    p90Ms: percentile(bucket.durations, 90) ?? null,
    tokensIn: bucket.tokensIn,
    tokensOut: bucket.tokensOut,
    repos: bucket.repos.size,
    errorKinds: Object.fromEntries([...bucket.errorKinds].sort((a, b) => b[1] - a[1])),
  }
}

/**
 * The scorecard over `records` for the last `days` (tasks started at or after the cutoff). A model
 * that was requested but served nothing for that task earns a `requested-only` row - that is the
 * Synapse re-routed / 404 signal, kept separate so it never inflates a real server's rate.
 */
export function scorecard(records: readonly TaskRecord[], now: number, days = 30): Scorecard {
  const since = now - days * DAY_MS
  const fresh = records.filter((r) => Date.parse(r.startedAt) >= since)
  const servedBuckets = new Map<string, Bucket>()
  const ghostBuckets = new Map<string, Bucket>()
  for (const record of fresh) {
    for (const model of Object.keys(record.servedModels ?? {})) {
      const bucket = servedBuckets.get(model) ?? emptyBucket()
      servedBuckets.set(model, bucket)
      add(bucket, record, servedShare(record, model))
    }
    // a task whose servedModels is empty cannot attribute any model - counted once, unscored
    const requested = record.requestedModel === undefined ? undefined : strip(record.requestedModel)
    // "auto" is Synapse's routing alias: it never appears as a served name, so it must not
    // become a re-routed ghost for every auto-routed task (the ghost means "an ask died unrouted").
    if (requested !== undefined && requested !== "auto" && record.servedModels !== undefined && !(requested in record.servedModels)) {
      const bucket = ghostBuckets.get(requested) ?? emptyBucket()
      ghostBuckets.set(requested, bucket)
      add(bucket, record, 1)
    }
  }
  return {
    generatedAt: new Date(now).toISOString(),
    days,
    since: new Date(since).toISOString(),
    tasks: fresh.length,
    models: [
      ...[...servedBuckets].map(([model, bucket]) => score(model, "served", bucket)),
      ...[...ghostBuckets].map(([model, bucket]) => score(model, "requested-only", bucket)),
    ].sort(byModel),
  }
}

/** The score row for the single model that carried most of a task's calls (mainServedModel, the label oc_report shows). */
export function scoreForMainServed(records: readonly TaskRecord[], now: number, days = 30): ModelScore[] {
  const since = now - days * DAY_MS
  const byName = new Map<string, TaskRecord[]>()
  for (const record of records) {
    if (Date.parse(record.startedAt) < since) continue
    const main = mainServedModel(record.servedModels)
    if (main === undefined) continue
    byName.set(main, [...(byName.get(main) ?? []), record])
  }
  return [...byName].map(([model, rows]) => {
    const bucket = emptyBucket()
    for (const record of rows) add(bucket, record, 1)
    return score(model, "served", bucket)
  })
}

/** Proven serving for role picks: wins = share of completed tasks a model carried; dead = an id
 *  that errored tasks while never serving a single call AND never served a call on ANY task in the
 *  window (the unroutable-catalogue-row pattern, e.g. Synapse's ghost claude-opus-5 404). Serving
 *  one call anywhere clears the flag: that model is flaky, not dead (CodeRabbit #156) - a route
 *  that starts working heals the exclusion on the next record, so only positive evidence gates. */
export type ServingHistory = { wins: Record<string, number>; dead: string[] }

export function servingHistory(records: readonly TaskRecord[], now: number, days = 30): ServingHistory {
  const since = now - days * DAY_MS
  const wins: Record<string, number> = {}
  const servedSomewhere = new Set<string>()
  const ghostErrors = new Set<string>()
  for (const record of records) {
    if (Date.parse(record.startedAt) < since) continue
    for (const [model, calls] of Object.entries(record.servedModels ?? {})) if (calls > 0) servedSomewhere.add(model)
    if (record.outcome === "completed") {
      for (const model of Object.keys(record.servedModels ?? {})) wins[model] = (wins[model] ?? 0) + servedShare(record, model)
    }
    const requested = record.requestedModel === undefined ? undefined : strip(record.requestedModel)
    // servedModels present + the asked id absent + the task errored: the request never reached the model.
    if (record.outcome === "error" && requested !== undefined && requested !== "auto" && record.servedModels !== undefined && !(requested in record.servedModels)) {
      ghostErrors.add(requested)
    }
  }
  return { wins, dead: [...ghostErrors].filter((model) => !servedSomewhere.has(model)).sort() }
}

/** One model's movement between two scorecards (the loop check-in delta). `new`/`gone` are the
 *  row appearing/disappearing between runs; `lowN` means under five finished tasks, where a rate
 *  move is mostly noise (display-only: ghost rows are inherently small-n, so they are flagged,
 *  never filtered - dropping them would kill the "an ask died unrouted" signal). */
export type DeltaLine = {
  model: string
  kind: ModelScore["kind"]
  rateFrom: number | null
  rateTo: number | null
  tasksFrom: number
  tasksTo: number
  new: boolean
  gone: boolean
  lowN: boolean
}

export type ScoreDelta = { firstRun: boolean; windowMismatch: boolean; daysFrom: number | null; lines: DeltaLine[] }

const finishedOf = (s: ModelScore | undefined): number => s === undefined ? 0 : s.completed + s.error + s.aborted + s.unknown
/** A share-weighted task count moves by at least this much before it is called a change. */
const MIN_TASK_MOVE = 0.5
const rowKey = (m: ModelScore) => `${m.kind} ${m.model}`

/**
 * What moved between the previous scorecard and this one. A different window is not comparable
 * (a 7d delta against a 30d table is mostly the window itself), so it says so and lists nothing.
 */
export function scoreDelta(current: Scorecard, previous: Scorecard | null): ScoreDelta {
  if (previous === null) return { firstRun: true, windowMismatch: false, daysFrom: null, lines: [] }
  if (previous.days !== current.days) return { firstRun: false, windowMismatch: true, daysFrom: previous.days, lines: [] }
  const nowByKey = new Map(current.models.map((m) => [rowKey(m), m]))
  const lines = current.models.flatMap((to): DeltaLine[] => {
    const from = previous.models.find((m) => rowKey(m) === rowKey(to))
    if (from === undefined) return [{ model: to.model, kind: to.kind, rateFrom: null, rateTo: to.successRate, tasksFrom: 0, tasksTo: to.tasks, new: true, gone: false, lowN: finishedOf(to) < 5 }]
    // a row only in `previous` is handled below as gone; here `to` always exists in current
    const rateChanged = from.successRate !== to.successRate
    const tasksMoved = Math.abs(to.tasks - from.tasks) >= MIN_TASK_MOVE
    if (!rateChanged && !tasksMoved) return []
    return [{ model: to.model, kind: to.kind, rateFrom: from.successRate, rateTo: to.successRate, tasksFrom: from.tasks, tasksTo: to.tasks, new: false, gone: false, lowN: Math.min(finishedOf(from), finishedOf(to)) < 5 }]
  })
  const goneLines = previous.models
    .filter((m) => !nowByKey.has(rowKey(m)))
    .map((from): DeltaLine => ({ model: from.model, kind: from.kind, rateFrom: from.successRate, rateTo: null, tasksFrom: from.tasks, tasksTo: 0, new: false, gone: true, lowN: finishedOf(from) < 5 }))
  return { firstRun: false, windowMismatch: false, daysFrom: previous.days, lines: [...lines, ...goneLines] }
}

/** A persisted snapshot re-read from disk: only the fields the delta needs are validated, and
 *  anything else (corrupt, wrong shape, hostile) reads as `null` = first run, never a crash. */
export function parseScorecardSnapshot(data: unknown): Scorecard | null {
  if (typeof data !== "object" || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.days !== "number" || !Number.isFinite(d.days) || typeof d.tasks !== "number" || !Number.isFinite(d.tasks)) return null
  if (!Array.isArray(d.models)) return null
  const models: ModelScore[] = []
  for (const raw of d.models) {
    if (typeof raw !== "object" || raw === null) return null
    const m = raw as Record<string, unknown>
    if (typeof m.model !== "string" || (m.kind !== "served" && m.kind !== "requested-only")) return null
    if (typeof m.tasks !== "number" || !Number.isFinite(m.tasks)) return null
    if (m.successRate !== null && (typeof m.successRate !== "number" || !Number.isFinite(m.successRate))) return null
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0
    models.push({
      model: m.model,
      kind: m.kind,
      tasks: m.tasks,
      completed: num(m.completed),
      error: num(m.error),
      aborted: num(m.aborted),
      unknown: num(m.unknown),
      running: num(m.running),
      successRate: m.successRate === null ? null : (m.successRate as number),
      medianMs: null,
      p90Ms: null,
      tokensIn: 0,
      tokensOut: 0,
      repos: 0,
      errorKinds: {},
    })
  }
  const text = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback)
  return { generatedAt: text(d.generatedAt, ""), days: d.days, since: text(d.since, ""), tasks: d.tasks, models }
}
