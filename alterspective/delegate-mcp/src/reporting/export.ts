// D7 (owner ask 2026-10-11): export delegated task outcomes as benchmark material for Synapse's
// suitability loop (issue Alterspective-Engine/Alterspective-Synapse#1918). One settled task is
// one row: which model served which calls, how it ended, how long it took, and whether the work
// was collected or discarded (the acceptance signal a benchmark cannot get from a model call alone).
// Pure over validated TaskRecords - no disk, no clock beyond the cutoff. Redaction (repo/caller
// hashed with a per-home salt) keeps client-derived names out of anything that leaves this PC.
import { createHash } from "node:crypto"
import type { TaskRecord } from "./record.ts"
import { mainServedModel } from "./served.ts"

export const EXPORT_VERSION = 1 as const
const DAY_MS = 24 * 60 * 60 * 1000
/** Settled tasks only: outcome is finished (summary.ts rule) and at least one model served a call. */
const isExportable = (r: TaskRecord) => r.outcome !== "running" && r.outcome !== "aborted" && (r.outcome !== "unknown" || r.sendCount > 0) && r.servedModels !== undefined

export type OutcomeRow = {
  v: typeof EXPORT_VERSION
  taskKey: string
  sessionID: string
  bridge: string
  repo: string
  caller?: string
  startedAt: string
  finishedAt?: string
  outcome: TaskRecord["outcome"]
  errorCode?: string
  requestedModel?: string
  servedModels: Record<string, number>
  mainModel?: string
  durationMs?: number
  sendCount: number
  tokens?: { input: number; output: number }
  collected: boolean
  disposition: TaskRecord["disposition"]
  outOfScopeCount?: number
}

/** A keyed short hash: stable for one salt, unlinkable across salts, never reversible by lookup alone. */
export function redact(salt: string, name: string): string {
  return `h:${createHash("sha256").update(`${salt}\n${name}`).digest("hex").slice(0, 12)}`
}

export type ExportOptions = { now: number; days?: number; salt: string; redactNames?: boolean }

export function outcomeRows(records: readonly TaskRecord[], options: ExportOptions): OutcomeRow[] {
  const since = options.now - (options.days ?? 90) * DAY_MS
  const hide = options.redactNames !== false
  return records
    .filter((r) => isExportable(r) && Date.parse(r.startedAt) >= since)
    .map((r) => ({
      v: EXPORT_VERSION,
      taskKey: r.key,
      sessionID: r.sessionID,
      bridge: r.bridge,
      repo: hide ? redact(options.salt, r.repo) : r.repo,
      ...(r.caller !== undefined ? { caller: hide ? redact(options.salt, r.caller) : r.caller } : {}),
      startedAt: r.startedAt,
      ...(r.finishedAt !== undefined ? { finishedAt: r.finishedAt } : {}),
      outcome: r.outcome,
      ...(r.errorCode !== undefined ? { errorCode: r.errorCode } : {}),
      ...(r.requestedModel !== undefined ? { requestedModel: r.requestedModel } : {}),
      servedModels: r.servedModels ?? {},
      ...(mainServedModel(r.servedModels) !== undefined ? { mainModel: mainServedModel(r.servedModels) } : {}),
      ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
      sendCount: r.sendCount,
      ...(r.tokens !== undefined ? { tokens: { input: r.tokens.input, output: r.tokens.output } } : {}),
      collected: r.collected,
      disposition: r.disposition,
      ...(r.outOfScopeCount !== undefined ? { outOfScopeCount: r.outOfScopeCount } : {}),
    }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}
