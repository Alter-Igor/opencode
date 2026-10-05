// #129: what the dashboard shows, computed from the host-side task records (src/reporting) of every
// bridge sharing this bridge home. A pure function: no clock, no disk, no Docker. Repo and model
// strings are data that a client or the box chose; they are cut here and the page never treats them as markup.
import type { Outcome, TaskRecord } from "../reporting/record.ts"
import { mainServedModel } from "../reporting/served.ts"

export const DAY_MS = 24 * 60 * 60 * 1000
export const MAX_RECENT_TASKS = 200
export const MAX_FIELD_CHARS = 128

export type DashboardExtras = { boxRunning: boolean; bridge: string }

export type BridgeRow = { bridge: string; running: number; last24h: number; last7d: number }
export type RunningRow = {
  bridge: string
  repo: string
  requestedModel?: string
  servedModels?: Record<string, number>
  startedAt: string
  lastSendAt?: string
  sendCount: number
  elapsedMs: number
}
export type RecentRow = {
  bridge: string
  repo: string
  requestedModel?: string
  servedModel?: string
  outcome: Outcome
  startedAt: string
  finishedAt?: string
  durationMs?: number
  errorCode?: string
  disposition: string
}
export type ServedRow = { model: string; calls: number }
export type DashboardData = {
  asOf: string
  bridge: string
  boxRunning: boolean
  busy: number
  bridges: BridgeRow[]
  running: RunningRow[]
  recent: RecentRow[]
  servedModels: ServedRow[]
}

const cut = (text: string) => text.slice(0, MAX_FIELD_CHARS)
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function dashboardData(records: readonly TaskRecord[], now: number, extras: DashboardExtras): DashboardData {
  const started = (r: TaskRecord) => Date.parse(r.startedAt)
  const newestFirst = (a: TaskRecord, b: TaskRecord) => started(b) - started(a) || byName(a.key, b.key)
  const running = records.filter((r) => r.outcome === "running")
  const week = records.filter((r) => now - started(r) <= 7 * DAY_MS)

  const perBridge = new Map<string, BridgeRow>()
  const rowFor = (name: string) => {
    const bridge = cut(name)
    const row = perBridge.get(bridge) ?? { bridge, running: 0, last24h: 0, last7d: 0 }
    perBridge.set(bridge, row)
    return row
  }
  for (const r of running) rowFor(r.bridge).running++
  for (const r of week) {
    const row = rowFor(r.bridge)
    row.last7d++
    if (now - started(r) <= DAY_MS) row.last24h++
  }

  const totals = new Map<string, number>()
  for (const r of week) for (const [model, calls] of Object.entries(r.servedModels ?? {})) totals.set(cut(model), (totals.get(cut(model)) ?? 0) + calls)

  return {
    asOf: new Date(now).toISOString(),
    bridge: cut(extras.bridge),
    boxRunning: extras.boxRunning,
    busy: running.length,
    bridges: [...perBridge.values()].sort((a, b) => b.running - a.running || byName(a.bridge, b.bridge)),
    running: [...running].sort(newestFirst).map((r) => ({
      bridge: cut(r.bridge),
      repo: cut(r.repo),
      ...(r.requestedModel ? { requestedModel: cut(r.requestedModel) } : {}),
      ...(r.servedModels ? { servedModels: Object.fromEntries(Object.entries(r.servedModels).map(([m, n]) => [cut(m), n])) } : {}),
      startedAt: r.startedAt,
      ...(r.lastSendAt ? { lastSendAt: r.lastSendAt } : {}),
      sendCount: r.sendCount,
      elapsedMs: Math.max(0, now - started(r)),
    })),
    recent: [...week].sort(newestFirst).slice(0, MAX_RECENT_TASKS).map((r) => {
      const main = mainServedModel(r.servedModels)
      return {
        bridge: cut(r.bridge),
        repo: cut(r.repo),
        ...(r.requestedModel ? { requestedModel: cut(r.requestedModel) } : {}),
        ...(main ? { servedModel: cut(main) } : {}),
        outcome: r.outcome,
        startedAt: r.startedAt,
        ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
        ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
        ...(r.errorCode ? { errorCode: r.errorCode } : {}),
        disposition: r.disposition,
      }
    }),
    servedModels: [...totals].map(([model, calls]) => ({ model, calls })).sort((a, b) => b.calls - a.calls || byName(a.model, b.model)),
  }
}
