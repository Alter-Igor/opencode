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
    if (requested !== undefined && record.servedModels !== undefined && !(requested in record.servedModels)) {
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
