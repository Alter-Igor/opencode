// #73: the hooks the session tools call to keep each task's record current. Every hook is
// best effort: it never throws, never makes an API call of its own (it reads what the tool already
// fetched) and never receives prompt or answer text. Hooks are idempotent: a wait or result call
// repeated on a finished run changes nothing, and only a new send starts a new run.
// One exception (#76): recordServed reads front's container log through Docker, in the background,
// so no tool waits for it.
import path from "node:path"
import type { BridgeConfig } from "../shared/config.ts"
import type { SessionState } from "../shared/contracts.ts"
import { safeLog } from "../shared/log.ts"
import { MODEL_RE } from "../supervisor/workspaces-state.ts"
import type { SessionRecord, ToolContext } from "../tools/context.ts"
import { errorCode, newTaskRecord, repoName, type Disposition, type Outcome, type TaskRecord, type Tokens } from "./record.ts"
import { keepServed } from "./served.ts"
import { createReportStore, type ReportStore } from "./store.ts"

type Ctx = Pick<ToolContext, "config" | "log" | "supervisor" | "sessions" | "caller">

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
    store = createReportStore({ dir, warn: (code, fields) => safeLog(ctx.log, "warn", "reporting", "task record not saved; reporting goes on without it", { code, ...fields }) })
    stores.set(dir, store)
  }
  return store
}

/** #76: served-model reads still running; their record update is queued only after the read. */
const reads = new Set<Promise<unknown>>()

/** Review cycle 2 (LOW 1): wait for every queued record update of every store (tests, shutdown). */
export async function flushReports(): Promise<void> {
  await Promise.all([...reads].map((r) => r.catch(() => undefined)))
  await Promise.all([...stores.values()].map((s) => s.flush()))
}

let hookFailureLogged = false

function hookFailed(ctx: Pick<ToolContext, "log">, error: unknown): void {
  if (hookFailureLogged) return
  hookFailureLogged = true
  safeLog(ctx.log, "warn", "reporting", "task record hook failed; reporting goes on without it", { code: error instanceof Error ? error.name : "unknown" })
}

/**
 * Run a hook. Review cycle 2 (LOW 1): a tool never waits on its record. The hook only queues the
 * update (the store keeps per-key order in this process) and returns at once; the update runs in
 * the background. Anything it throws, now or later, is logged once per process and otherwise ignored.
 */
function guarded(ctx: Pick<ToolContext, "log">, fn: () => Promise<unknown> | void): void {
  try {
    const pending = fn()
    if (pending) void pending.catch((error: unknown) => hookFailed(ctx, error))
  } catch (error) {
    hookFailed(ctx, error)
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
    caller: ctx.caller,
    startedAt: ISO_RE.test(rec.createdAt) ? rec.createdAt : nowIso(),
    agent: rec.agent,
    requestedModel: rec.model,
  })
}

/** oc_start_session: create the task's record. */
export function recordStart(ctx: Ctx, rec: SessionRecord): void {
  return guarded(ctx, () => reportsFor(ctx).update(rec.sessionKey, (current) => current ?? { ...fresh(ctx, rec), startedAt: nowIso() }))
}

/**
 * oc_send (and every prompt through sendPrompt): the model and agent actually sent; a new run starts.
 * `at` is when the send began, taken before the prompt POST (review cycle 1, LOW 5): a run that
 * settles while the POST is in flight is then not mistaken for a stale state.
 */
export function recordSend(ctx: Ctx, rec: SessionRecord, sent: { model?: string; agent?: string; at?: string }): void {
  return guarded(ctx, () =>
    reportsFor(ctx).update(rec.sessionKey, (current) => {
      const base = current ?? fresh(ctx, rec)
      const at = sent.at && ISO_RE.test(sent.at) ? sent.at : nowIso()
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
  const code = end.code ?? (end.outcome === "error" ? errorCode(seen.lastError ?? "") : undefined)
  return ended(record, end.outcome, finishedAt, code)
}

function ended(record: TaskRecord, outcome: Outcome, finishedAt: string, code?: string): TaskRecord {
  const first = record.firstSendAt ? Date.parse(record.firstSendAt) : Number.NaN
  return {
    ...record,
    outcome,
    finishedAt,
    ...(Number.isFinite(first) ? { durationMs: Math.max(0, Date.parse(finishedAt) - first) } : {}),
    ...(code ? { errorCode: code } : {}),
  }
}

/** oc_wait: the states the wait already returned (views, then the latest state event per session). */
export function recordStates(ctx: Ctx, states: readonly ObservedState[]): void {
  return guarded(ctx, () => {
    const latest = new Map<string, ObservedState>()
    for (const s of states) latest.set(s.sessionID, s)
    for (const seen of latest.values()) {
      const key = ctx.sessions.get(seen.sessionID)?.sessionKey
      if (key) void reportsFor(ctx).update(key, (current) => (current ? finish(current, seen) : undefined))
    }
  })
}

type MessageInfo = { role?: unknown; tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } } }
const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0)

/**
 * Token totals over the assistant messages oc_result read (a lower bound). Review cycle 1: no served
 * model is taken from them: providerID/modelID only echo the requested ids (synapse/auto).
 */
export function usageOf(messages: readonly unknown[]): { tokens?: Tokens } {
  let tokens: Tokens | undefined
  for (const m of messages) {
    const info = (m as { info?: MessageInfo } | undefined)?.info
    if (!info || info.role !== "assistant") continue
    const t = info.tokens
    if (!t || typeof t !== "object") continue
    tokens ??= { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    tokens.input += n(t.input)
    tokens.output += n(t.output)
    tokens.reasoning += n(t.reasoning)
    tokens.cacheRead += n(t.cache?.read)
    tokens.cacheWrite += n(t.cache?.write)
  }
  return tokens ? { tokens } : {}
}

const total = (t: Tokens | undefined) => (t ? t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite : -1)

/** oc_result: tokens from the messages it fetched, and the state it read. */
export function recordResult(ctx: Ctx, rec: SessionRecord, seen: { state: SessionState; at?: string }, messages: readonly unknown[]): void {
  return guarded(ctx, () =>
    reportsFor(ctx).update(rec.sessionKey, (current) => {
      if (!current) return undefined
      const usage = usageOf(messages)
      const done = finish(current, { sessionID: rec.sessionID, ...seen }) ?? current
      // Repeated reads never lower the count (a later read may see a shorter window).
      const tokens = total(usage.tokens) > total(done.tokens) ? usage.tokens : done.tokens
      const next: TaskRecord = { ...done, ...(tokens ? { tokens } : {}) }
      return JSON.stringify(next) === JSON.stringify(current) ? undefined : next
    }),
  )
}

/**
 * #76, oc_result and close: which models Synapse served this task's calls, from front's log since
 * the first send. Runs in the background; a log that cannot be read leaves the record as it is.
 */
export function recordServed(ctx: Ctx & Pick<ToolContext, "servedModels">, key: string, sessionID: string): void {
  const read = ctx.servedModels
  if (!read) return
  return guarded(ctx, () => {
    const run = (async () => {
      const store = reportsFor(ctx)
      const current = store.get(key)
      if (!current || current.sendCount === 0) return
      const served = await read(sessionID, current.firstSendAt ?? current.startedAt)
      if (!served) return
      await store.update(key, (latest) => {
        if (!latest) return undefined
        const kept = keepServed(latest.servedModels, served)
        return kept === latest.servedModels ? undefined : { ...latest, servedModels: kept }
      })
    })()
    reads.add(run)
    void run.finally(() => reads.delete(run)).catch(() => undefined)
    return run
  })
}

/** oc_collect: the host-verified commit count. */
export function recordCollect(ctx: Ctx, rec: SessionRecord, commits: number): void {
  return guarded(ctx, () =>
    reportsFor(ctx).update(rec.sessionKey, (current) => {
      const base = current ?? fresh(ctx, rec)
      const collected = base.collected || commits > 0
      return { ...base, commitsCollected: commits, collected, ...(collected && base.disposition === "open" ? { disposition: "collected" as const } : {}) }
    }),
  )
}

/**
 * oc_close_session / oc_cleanup: what happened to the copy. Only an existing record is updated.
 * Review cycles 1-2: a run still marked running ends here. An abort the close sent makes it aborted;
 * else the state the close read decides (idle with no error: completed; an error state, or idle
 * with an error seen: error; a hub abort: aborted). A state from before the last send, or none,
 * gives unknown, which counts as finished and so lowers the success rate.
 */
export function recordClose(ctx: Ctx, key: string, disposition: Exclude<Disposition, "open" | "collected">, end: { aborted?: boolean; seen?: Omit<ObservedState, "sessionID"> } = {}): void {
  return guarded(ctx, () =>
    reportsFor(ctx).update(key, (current) => {
      if (!current) return undefined
      const at = nowIso()
      return { ...(current.outcome === "running" ? closedRun(current, at, end) : current), disposition, closedAt: at }
    }),
  )
}

function closedRun(record: TaskRecord, at: string, end: { aborted?: boolean; seen?: Omit<ObservedState, "sessionID"> }): TaskRecord {
  if (end.aborted) return ended(record, "aborted", at)
  const seen = end.seen
  // Cycle 3: idle is completed, as in recordStates. `lastError` on an idle view can be a disarmed
  // label left from an earlier run (events/state.ts), so it says nothing about this one.
  const done = seen && seen.state !== "not_found" ? finish(record, { sessionID: record.sessionID, ...seen }) : undefined
  return done ?? ended(record, "unknown", at)
}
