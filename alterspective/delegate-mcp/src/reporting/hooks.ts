// #73: the hooks the session tools call to keep each task's record current. Every hook is
// best effort: it never throws, never makes an API call of its own (it reads what the tool already
// fetched) and never receives prompt or answer text. Hooks are idempotent: a wait or result call
// repeated on a finished run changes nothing, and only a new send starts a new run.
import path from "node:path"
import type { BridgeConfig } from "../shared/config.ts"
import type { SessionState } from "../shared/contracts.ts"
import { safeLog } from "../shared/log.ts"
import { MODEL_RE } from "../supervisor/workspaces-state.ts"
import type { SessionRecord, ToolContext } from "../tools/context.ts"
import { ERROR_CODE_RE, newTaskRecord, repoName, type Disposition, type Outcome, type TaskRecord, type Tokens } from "./record.ts"
import { createReportStore, type ReportStore } from "./store.ts"

type Ctx = Pick<ToolContext, "config" | "log" | "supervisor" | "sessions">

/** The bridge's host state folder (<home>/workspaces, as workspaces.ts) plus `reports`. Never mounted in the box. */
export function reportsDir(config: Pick<BridgeConfig, "home">): string {
  return path.join(config.home, "workspaces", "reports")
}

const stores = new Map<string, ReportStore>()

/** The store for this bridge home (one per folder per process, so per-key ordering holds). */
export function reportsFor(ctx: Pick<ToolContext, "config" | "log">): ReportStore {
  const dir = reportsDir(ctx.config)
  let store = stores.get(dir)
  if (!store) {
    // WEBSTA-001-SECRETS-MANAGEMENT-STANDARDS: the error code only; no path, no record content.
    store = createReportStore({ dir, warn: (code) => safeLog(ctx.log, "warn", "reporting", "task record not saved; reporting goes on without it", { code }) })
    stores.set(dir, store)
  }
  return store
}

let hookFailureLogged = false

/** Run a hook; anything it throws is logged once per process and otherwise ignored. */
async function guarded(ctx: Pick<ToolContext, "log">, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (error) {
    if (hookFailureLogged) return
    hookFailureLogged = true
    safeLog(ctx.log, "warn", "reporting", "task record hook failed; reporting goes on without it", { code: error instanceof Error ? error.name : "unknown" })
  }
}

const bridgeName = (ctx: Pick<ToolContext, "supervisor">) => ctx.supervisor.replace(/^supervisor:/, "")
const nowIso = () => new Date().toISOString()
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

function fresh(ctx: Ctx, rec: SessionRecord): TaskRecord {
  return newTaskRecord({
    sessionID: rec.sessionID,
    key: rec.sessionKey,
    bridge: bridgeName(ctx),
    repo: repoName(rec.hostRepo),
    startedAt: ISO_RE.test(rec.createdAt) ? rec.createdAt : nowIso(),
    agent: rec.agent,
    requestedModel: rec.model,
  })
}

/** oc_start_session: create the task's record. */
export function recordStart(ctx: Ctx, rec: SessionRecord): Promise<void> {
  return guarded(ctx, () => reportsFor(ctx).update(rec.sessionKey, (current) => current ?? { ...fresh(ctx, rec), startedAt: nowIso() }))
}

/** oc_send (and every prompt through sendPrompt): the model and agent actually sent; a new run starts. */
export function recordSend(ctx: Ctx, rec: SessionRecord, sent: { model?: string; agent?: string }): Promise<void> {
  return guarded(ctx, () =>
    reportsFor(ctx).update(rec.sessionKey, (current) => {
      const base = current ?? fresh(ctx, rec)
      const at = nowIso()
      const { finishedAt: _f, durationMs: _d, errorCode: _e, ...rest } = base
      return {
        ...rest,
        sendCount: base.sendCount + 1,
        firstSendAt: base.firstSendAt ?? at,
        lastSendAt: at,
        outcome: "running",
        ...(sent.model && MODEL_RE.test(sent.model) ? { requestedModel: sent.model } : {}),
        ...(sent.agent ? { agent: sent.agent } : {}),
      }
    }),
  )
}

/** What a settled hub state means for the run; undefined while it is still going (or unknowable). */
function settled(state: SessionState): { outcome: Outcome; code?: string } | undefined {
  switch (state) {
    case "idle":
      return { outcome: "completed" }
    case "error":
      return { outcome: "error" }
    case "aborted":
      return { outcome: "aborted" }
    case "not_started":
      return { outcome: "error", code: "not_started" }
    case "not_found":
      return { outcome: "unknown", code: "not_found" }
    default:
      return undefined
  }
}

export type ObservedState = { sessionID: string; state: SessionState; at?: string; lastError?: string }

/** Finish the running run once. A state observed before the last send is stale and ignored. */
function finish(record: TaskRecord, seen: ObservedState): TaskRecord | undefined {
  const end = settled(seen.state)
  if (!end || record.outcome !== "running") return undefined
  const at = seen.at ? Date.parse(seen.at) : Number.NaN
  if (record.lastSendAt && at < Date.parse(record.lastSendAt)) return undefined
  const finishedAt = Number.isFinite(at) ? new Date(at).toISOString() : nowIso()
  const first = record.firstSendAt ? Date.parse(record.firstSendAt) : Number.NaN
  const code = end.code ?? (end.outcome === "error" && seen.lastError && ERROR_CODE_RE.test(seen.lastError) ? seen.lastError : undefined)
  return {
    ...record,
    outcome: end.outcome,
    finishedAt,
    ...(Number.isFinite(first) ? { durationMs: Math.max(0, Date.parse(finishedAt) - first) } : {}),
    ...(code ? { errorCode: code } : {}),
  }
}

/** oc_wait: the states the wait already returned (views, then the latest state event per session). */
export function recordStates(ctx: Ctx, states: readonly ObservedState[]): Promise<void> {
  return guarded(ctx, async () => {
    const latest = new Map<string, ObservedState>()
    for (const s of states) latest.set(s.sessionID, s)
    for (const seen of latest.values()) {
      const key = ctx.sessions.get(seen.sessionID)?.sessionKey
      if (key) await reportsFor(ctx).update(key, (current) => (current ? finish(current, seen) : undefined))
    }
  })
}

type MessageInfo = { role?: unknown; providerID?: unknown; modelID?: unknown; tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } } }
const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0)

/** The served model (last assistant message) and token totals over the messages oc_result read. */
export function usageOf(messages: readonly unknown[]): { servedModel?: string; tokens?: Tokens } {
  let servedModel: string | undefined
  let tokens: Tokens | undefined
  for (const m of messages) {
    const info = (m as { info?: MessageInfo } | undefined)?.info
    if (!info || info.role !== "assistant") continue
    if (typeof info.providerID === "string" && typeof info.modelID === "string" && MODEL_RE.test(`${info.providerID}/${info.modelID}`)) servedModel = `${info.providerID}/${info.modelID}`
    const t = info.tokens
    if (!t || typeof t !== "object") continue
    tokens ??= { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    tokens.input += n(t.input)
    tokens.output += n(t.output)
    tokens.reasoning += n(t.reasoning)
    tokens.cacheRead += n(t.cache?.read)
    tokens.cacheWrite += n(t.cache?.write)
  }
  return { ...(servedModel ? { servedModel } : {}), ...(tokens ? { tokens } : {}) }
}

const total = (t: Tokens | undefined) => (t ? t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite : -1)

/** oc_result: served model and tokens from the messages it fetched, and the state it read. */
export function recordResult(ctx: Ctx, rec: SessionRecord, seen: { state: SessionState; at?: string }, messages: readonly unknown[]): Promise<void> {
  return guarded(ctx, () =>
    reportsFor(ctx).update(rec.sessionKey, (current) => {
      if (!current) return undefined
      const usage = usageOf(messages)
      const done = finish(current, { sessionID: rec.sessionID, ...seen }) ?? current
      // Repeated reads never lower the count (a later read may see a shorter window).
      const tokens = total(usage.tokens) > total(done.tokens) ? usage.tokens : done.tokens
      const next: TaskRecord = { ...done, ...(usage.servedModel ? { servedModel: usage.servedModel } : {}), ...(tokens ? { tokens } : {}) }
      return JSON.stringify(next) === JSON.stringify(current) ? undefined : next
    }),
  )
}

/** oc_collect: the host-verified commit count. */
export function recordCollect(ctx: Ctx, rec: SessionRecord, commits: number): Promise<void> {
  return guarded(ctx, () =>
    reportsFor(ctx).update(rec.sessionKey, (current) => {
      const base = current ?? fresh(ctx, rec)
      const collected = base.collected || commits > 0
      return { ...base, commitsCollected: commits, collected, ...(collected && base.disposition === "open" ? { disposition: "collected" as const } : {}) }
    }),
  )
}

/** oc_close_session / oc_cleanup: what happened to the copy. Only an existing record is updated. */
export function recordClose(ctx: Ctx, key: string, disposition: Exclude<Disposition, "open" | "collected">): Promise<void> {
  return guarded(ctx, () => reportsFor(ctx).update(key, (current) => (current ? { ...current, disposition, closedAt: nowIso() } : undefined)))
}
