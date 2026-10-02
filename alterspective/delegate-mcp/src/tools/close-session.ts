// #72: oc_close_session and oc_cleanup. Nothing else removes finished delegated work: the box clone
// (/sessions/<key>), the OpenCode session, the host record and the fetched delegate/<key> branch.
// Both close only sessions whose host record names this bridge and this box (workspaces-close.ts
// re-checks that before anything is sent). Two separate opt-ins (review cycle 1): `abort` stops a
// running session first; `discardWork` allows deleting commits no host branch has, uncommitted
// files and an unmerged delegate branch. oc_cleanup uses neither. Every close holds the close lock
// (closing.ts), so oc_send / oc_collect refuse the session meanwhile. Results carry ids, keys, counts.
import { z } from "zod"
import { DelegateError } from "../shared/errors.ts"
import type { SessionState } from "../shared/contracts.ts"
import type { CloseOutcome, SessionRemoval } from "../supervisor/workspaces.ts"
import type { Box, ToolContext } from "./context.ts"
import { whileClosing } from "./closing.ts"
import { boxPathOf, checkSessionId, hostState, ownedStates, recordFromState, sessionIdSchema, type RemoteSession } from "./core-session.ts"
import { defineTool } from "./define.ts"
import { ok, untrusted } from "./shape.ts"

export const TTL_ENV = "OPENCODE_DELEGATE_SESSION_TTL_DAYS"
export const DEFAULT_TTL_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000
/** Records looked at per oc_cleanup call, and sessions closed (or listed) per call. */
const MAX_EXAMINED = 20
const MAX_CLOSED = 10
/** After an abort: how often, and how long apart, the state is read until the run has stopped. */
const STOP_POLLS = 10
const STOP_POLL_MS = 300
/** A running session may still change its copy. */
const ACTIVE: ReadonlySet<SessionState> = new Set<SessionState>(["starting", "busy", "retry", "needs_input"])
/** States that say nothing about the copy: the close is refused, to be retried (never forced). */
const UNVERIFIED: ReadonlySet<SessionState> = new Set<SessionState>(["unknown", "server_down"])

/** OPENCODE_DELEGATE_SESSION_TTL_DAYS: whole days, 0 disables; unset is 14. */
export function ttlDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TTL_DAYS
  if (!/^\d{1,4}$/.test(raw.trim())) throw new DelegateError("invalid_input", `${TTL_ENV} must be a whole number of days (0 disables the sweep).`, `Set ${TTL_ENV} to e.g. 14, or unset it.`)
  return Number(raw.trim())
}

type Located = { sessionKey: string; remote?: RemoteSession }

const notOurs = (sessionID: string) =>
  new DelegateError("not_found", `Session ${sessionID} is not one of this bridge's sessions.`, "Use oc_list_sessions to see this bridge's sessions.")

/** The key of one of our sessions: tracked, named by the box's metadata, or (box lost it) by a host record. */
async function locate(ctx: ToolContext, box: Box, sessionID: string, correlationId: string): Promise<Located> {
  checkSessionId(sessionID)
  const known = ctx.sessions.get(sessionID)
  const res = await box.api.call<RemoteSession>({ path: `/session/${sessionID}`, directory: known?.boxPath, correlationId })
  if (res.status === 200 && res.data?.id === sessionID) {
    const key = known?.sessionKey ?? (typeof res.data.metadata?.sessionKey === "string" ? res.data.metadata.sessionKey : "")
    if (!known && res.data.directory !== boxPathOf(key)) throw notOurs(sessionID)
    return { sessionKey: key, remote: res.data }
  }
  if (res.status !== 404) throw new DelegateError("upstream_error", "The delegate server failed to read the session.", "Retry; if it repeats, run oc_doctor.", `HTTP ${res.status}`)
  const key = known?.sessionKey ?? (await ownedStates(ctx)).find((s) => s.sessionID === sessionID)?.sessionKey
  if (!key) throw notOurs(sessionID)
  return { sessionKey: key }
}

/** DELETE /session/:id; 404 means the sandbox no longer has it. Anything else throws (nothing else is removed). */
function sessionDeleter(box: Box, sessionID: string, sessionKey: string, correlationId: string): () => Promise<SessionRemoval> {
  return async () => {
    const res = await box.api.call<unknown>({ method: "DELETE", path: `/session/${sessionID}`, directory: boxPathOf(sessionKey), correlationId })
    if (res.status === 404) return "already_gone"
    if (res.status >= 200 && res.status < 300) return "deleted"
    throw new DelegateError("upstream_error", "The sandbox failed to delete the session; its copy and record were kept.", "Retry oc_close_session; if it repeats, run oc_doctor.", `HTTP ${res.status}`)
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
const unverified = (sessionID: string, state: SessionState) =>
  new DelegateError("upstream_error", `Could not verify the state of session ${sessionID} (${state}), so nothing was deleted.`, "Retry in a moment; if it repeats, run oc_doctor.")
const active = (sessionID: string, state: SessionState, aborted: boolean) =>
  aborted
    ? new DelegateError("session_active", `Session ${sessionID} was asked to abort but is still ${state}, so nothing was deleted.`, "Retry in a moment; check oc_status.")
    : new DelegateError("session_active", `Session ${sessionID} is ${state}, so nothing was deleted.`, "Wait for it with oc_wait, or pass abort: true to stop it first.")

/** Box-supplied path names, shown only when they are plain (anything else is counted, not echoed). */
const PLAIN_PATH = /^[A-Za-z0-9._@+/-]{1,200}$/
function examples(paths: readonly string[]): string {
  const plain = paths.filter((p) => PLAIN_PATH.test(p))
  const odd = paths.length - plain.length
  return [...plain, ...(odd ? [`${odd} with unusual names`] : [])].join(", ")
}

function refusalError(sessionID: string, outcome: Pick<CloseOutcome, "refused" | "uncollectedCommits" | "uncommittedPaths" | "ignoredPaths" | "ignoredExamples">, canCollect: boolean): DelegateError {
  if (outcome.refused === "ignored_files")
    return new DelegateError(
      "uncollected_work",
      `Session ${sessionID}'s copy has ${plural(outcome.ignoredPaths, "git-ignored path")} that oc_collect does not carry (${examples(outcome.ignoredExamples)}), so nothing was deleted.`,
      "Copy what you need out of the sandbox first, or pass discardWork: true to delete them. Dependency and cache folders (node_modules, .cache, .turbo, __pycache__, .pytest_cache, .venv, coverage) never block.",
    )
  if (outcome.refused === "check_failed") return new DelegateError("upstream_error", `Could not check session ${sessionID}'s copy for uncollected work, so nothing was deleted.`, "Retry; if it repeats, run oc_doctor.")
  const lost = [outcome.uncollectedCommits ? plural(outcome.uncollectedCommits, "uncollected commit") : "", outcome.uncommittedPaths ? plural(outcome.uncommittedPaths, "uncommitted file") : ""].filter(Boolean).join(" and ")
  const action = canCollect
    ? "Fetch them with oc_collect first (ask the agent to commit loose files), or pass discardWork: true to delete them."
    : "The sandbox no longer has this session, so the bridge cannot fetch them; pass discardWork: true to delete them, or copy them out of the sandbox by hand."
  return new DelegateError("uncollected_work", `Session ${sessionID} still has ${lost} in the sandbox, so nothing was deleted.`, action)
}

/** The state now; refuses an unverifiable one. */
async function stateOf(box: Box, sessionID: string): Promise<SessionState> {
  const state = (await box.hub.view(sessionID)).state
  if (UNVERIFIED.has(state)) throw unverified(sessionID, state)
  return state
}

/** The stop hook: nothing to do for a session the sandbox lost; an active one is refused, or aborted and awaited. */
async function stopSession(ctx: ToolContext, box: Box, located: Located, sessionID: string, abort: boolean, correlationId: string): Promise<boolean> {
  if (!located.remote) return false
  let state = await stateOf(box, sessionID)
  if (!ACTIVE.has(state)) return false
  if (!abort) throw active(sessionID, state, false)
  const res = await box.api.call<unknown>({ method: "POST", path: `/session/${sessionID}/abort`, directory: boxPathOf(located.sessionKey), correlationId })
  ctx.log.log("info", "tools", "abort sent before closing a session", { sessionID, correlationId, status: res.status })
  if (res.status < 200 || res.status >= 300) throw new DelegateError("upstream_error", `The sandbox did not accept the abort of session ${sessionID}, so nothing was deleted.`, "Retry; check oc_status.", `HTTP ${res.status}`)
  for (let poll = 0; poll < STOP_POLLS; poll++) {
    state = await stateOf(box, sessionID)
    if (!ACTIVE.has(state)) return true
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS))
  }
  throw active(sessionID, state, true)
}

/** After a late refusal (session deleted, copy kept): keep the session tracked so oc_collect still works in this run. */
async function keepTracked(ctx: ToolContext, sessionID: string, sessionKey: string): Promise<void> {
  if (ctx.sessions.has(sessionID)) return
  const state = await hostState(ctx, sessionKey)
  if (state?.sessionID !== sessionID) return
  try {
    ctx.sessions.set(sessionID, await recordFromState(ctx, { ...state, sessionID }))
  } catch {
    ctx.log.log("warn", "tools", "a kept session copy could not be tracked", { sessionKey })
  }
}

function closeSummary(o: CloseOutcome): string {
  const lost = o.uncollectedCommits || o.uncommittedPaths ? ` Deleted (discardWork) ${plural(o.uncollectedCommits, "uncollected commit")} and ${plural(o.uncommittedPaths, "uncommitted file")}.` : ""
  const ignored = o.ignoredPaths ? ` Deleted (discardWork) ${plural(o.ignoredPaths, "git-ignored path")}.` : ""
  const discarded = o.discardedCommits ? ` ${plural(o.discardedCommits, "discarded commit")} (replaced by amend or reset, reflog only) went with the copy.` : ""
  if (o.closed) return `Session ${o.sessionID} closed: session ${o.session}, copy ${o.clone}, record removed, branch ${o.branch}.${lost}${ignored}${discarded}`
  const why = o.refused ? ` Refused (${o.refused}): ${plural(o.uncollectedCommits, "uncollected commit")}, ${plural(o.uncommittedPaths, "uncommitted file")} and ${plural(o.ignoredPaths, "git-ignored path")} appeared while closing, so the copy and its host record were kept; oc_collect can still fetch it.` : ""
  return `Session ${o.sessionID} only partly closed (session ${o.session}, copy ${o.clone}, branch ${o.branch}, record ${o.record}); the host record was kept, so oc_close_session can be retried.${why}`
}

type CloseArgs = { sessionID: string; deleteBranch?: boolean; abort?: boolean; discardWork?: boolean }

async function closeOne(ctx: ToolContext, box: Box, located: Located, args: CloseArgs, correlationId: string) {
  let aborted = false
  const owner = { supervisor: ctx.supervisor, sessionID: args.sessionID }
  const outcome = await ctx.workspaces.closeSession(located.sessionKey, owner, { discardWork: args.discardWork === true, deleteBranch: args.deleteBranch === true }, {
    stop: async () => {
      aborted = await stopSession(ctx, box, located, args.sessionID, args.abort === true, correlationId)
    },
    deleteSession: sessionDeleter(box, args.sessionID, located.sessionKey, correlationId),
  })
  const canCollect = located.remote !== undefined || ctx.sessions.has(args.sessionID)
  if (outcome.refused && outcome.session === "kept") {
    // Refused before stopping: a running session is the more useful answer (its work is not done yet).
    if (!aborted && located.remote && args.abort !== true) {
      const state = await stateOf(box, args.sessionID)
      if (ACTIVE.has(state)) throw active(args.sessionID, state, false)
    }
    throw refusalError(args.sessionID, outcome, canCollect)
  }
  if (outcome.closed) ctx.sessions.delete(args.sessionID)
  else if (outcome.session !== "kept") await keepTracked(ctx, args.sessionID, located.sessionKey)
  const { ignoredExamples, ...rest } = outcome
  return ok(closeSummary(outcome), { ...rest, aborted, ...(ignoredExamples.length ? { ignoredExamples: untrusted(ignoredExamples.join("\n"), 2000) } : {}) })
}

export const closeSessionTool = defineTool({
  name: "oc_close_session",
  title: "Close a finished session",
  description:
    "Delete one of this bridge's finished sessions: the OpenCode session, its copy in the sandbox and the bridge's host record. Refused while the session is running or needs input (abort: true stops it first), while its state cannot be read (retry), and while its copy has commits no host branch has, uncommitted files, or git-ignored files other than dependency/cache folders (node_modules, .cache, .turbo, __pycache__, .pytest_cache, .venv, coverage) such as dist/ or .env (run oc_collect or copy them first; discardWork: true deletes them). Commits only the reflog still holds (replaced by amend or reset) never block and are reported as discardedCommits. " +
    "deleteBranch: true also deletes the host branch delegate/<key>, only when another host branch contains it (discardWork: true deletes it unmerged); a branch checked out anywhere or a symbolic ref is never deleted, and no other branch is touched.",
  input: {
    sessionID: sessionIdSchema,
    deleteBranch: z.boolean().optional().describe("Also delete the host branch delegate/<key> when another branch contains it. Default false."),
    abort: z.boolean().optional().describe("Stop a running session before closing it. Its work is still checked afterwards. Default false."),
    discardWork: z.boolean().optional().describe("Allow deleting commits no host branch has, uncommitted files and an unmerged delegate/<key>. Default false."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const box = await ctx.box()
    const located = await locate(ctx, box, args.sessionID, correlationId)
    return whileClosing(ctx, args.sessionID, () => closeOne(ctx, box, located, args, correlationId))
  },
})

type Row = { sessionKey: string; reason: string; uncollectedCommits: number; uncommittedPaths: number; ignoredPaths: number; discardedCommits: number }
type Sweep = { closed: string[]; wouldClose: string[]; kept: Row[]; partial: string[]; skipped: { recent: number; active: number; unknown: number } }
type Candidate = { sessionID: string; sessionKey: string; createdAt: string }
type SweepRun = { ctx: ToolContext; box: Box; cutoff: number; dryRun: boolean; deleteBranch: boolean; correlationId: string; out: Sweep }

/** Last activity: the server's update time when it still has the session, else the record's creation. */
async function lastActive(run: SweepRun, state: Candidate): Promise<{ at: number; present: boolean } | undefined> {
  const res = await run.box.api.call<RemoteSession>({ path: `/session/${state.sessionID}`, directory: boxPathOf(state.sessionKey), correlationId: run.correlationId }).catch(() => undefined)
  const created = Date.parse(state.createdAt)
  if (res?.status === 404) return { at: created, present: false }
  if (res?.status !== 200 || res.data?.id !== state.sessionID) return undefined
  const updated = res.data.time?.updated
  return { at: typeof updated === "number" && Number.isFinite(updated) ? Math.max(created, updated) : created, present: true }
}

/** Why a candidate is not swept now, or whether the sandbox still has it when it is stale and idle. */
async function staleness(run: SweepRun, state: Candidate): Promise<{ skip: keyof Sweep["skipped"] } | { present: boolean }> {
  const last = await lastActive(run, state)
  if (!last) return { skip: "unknown" }
  if (last.at >= run.cutoff) return { skip: "recent" }
  if (!last.present) return { present: false }
  const now = (await run.box.hub.view(state.sessionID)).state
  return UNVERIFIED.has(now) ? { skip: "unknown" } : ACTIVE.has(now) ? { skip: "active" } : { present: true }
}

function keep(out: Sweep, sessionKey: string, reason: string, o: Omit<Row, "sessionKey" | "reason">): void {
  out.kept.push({ sessionKey, reason, uncollectedCommits: o.uncollectedCommits, uncommittedPaths: o.uncommittedPaths, ignoredPaths: o.ignoredPaths, discardedCommits: o.discardedCommits })
}

/** One stale candidate: listed (dry run) or closed with every guard, never aborted, never discarding work. */
async function sweepOne(run: SweepRun, state: Candidate): Promise<void> {
  const { ctx, out } = run
  const stale = await staleness(run, state)
  if ("skip" in stale) {
    out.skipped[stale.skip]++
    return
  }
  const owner = { supervisor: ctx.supervisor, sessionID: state.sessionID }
  if (run.dryRun) {
    const plan = await ctx.workspaces.inspectClose(state.sessionKey, owner, { deleteBranch: run.deleteBranch })
    if (plan.safe) out.wouldClose.push(state.sessionKey)
    else keep(out, state.sessionKey, plan.reason ?? "check_failed", plan)
    return
  }
  const located: Located = { sessionKey: state.sessionKey, ...(stale.present ? { remote: { id: state.sessionID } } : {}) }
  const o = await whileClosing(ctx, state.sessionID, () =>
    ctx.workspaces.closeSession(state.sessionKey, owner, { discardWork: false, deleteBranch: run.deleteBranch }, {
      stop: async () => {
        await stopSession(ctx, run.box, located, state.sessionID, false, run.correlationId)
      },
      deleteSession: sessionDeleter(run.box, state.sessionID, state.sessionKey, run.correlationId),
    }),
  )
  if (o.closed) {
    ctx.sessions.delete(state.sessionID)
    out.closed.push(state.sessionKey)
  } else if (o.refused && o.session === "kept") keep(out, state.sessionKey, o.refused, o)
  else {
    // Late refusal (session deleted, copy and host record kept): same handling as oc_close_session.
    out.partial.push(state.sessionKey)
    if (o.session !== "kept") await keepTracked(ctx, state.sessionID, state.sessionKey)
  }
}

function sweepSummary(out: Sweep, dryRun: boolean, days: number, examined: number, otherBridge: number): string {
  const done = dryRun ? `${plural(out.wouldClose.length, "session")} would be closed` : `${plural(out.closed.length, "session")} closed`
  const others = otherBridge ? ` ${plural(otherBridge, "record")} name another bridge and were not touched: a bridge only sweeps its own sessions, so set OPENCODE_DELEGATE_NAME to a fixed name to sweep later runs' sessions.` : ""
  return `${done}; ${out.kept.length} kept for uncollected work or failed checks (older than ${days} days, ${plural(examined, "record")} looked at; each call continues where the last one stopped).${others}`
}

export const cleanupTool = defineTool({
  name: "oc_cleanup",
  title: "Sweep stale sessions",
  description:
    `Find this bridge's sessions idle longer than ${TTL_ENV} days (default ${DEFAULT_TTL_DAYS}; 0 disables) and close them with oc_close_session's guards, never aborting and never discarding work: a session with uncollected commits, uncommitted files or blocking git-ignored files (anything but dependency/cache folders), or one that is running, needs input or cannot be checked, is kept and listed with its reason. ` +
    `dryRun (default true) only lists what would be removed. Each call looks at up to ${MAX_EXAMINED} records and closes up to ${MAX_CLOSED}, continuing where the last call stopped. Only sessions of this bridge's name are seen. deleteBranch: true also deletes delegate/<key> branches another host branch contains.`,
  input: {
    dryRun: z.boolean().optional().describe("Only report what would be removed. Default true."),
    deleteBranch: z.boolean().optional().describe("Also delete each closed session's host branch when another branch contains it. Default false."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const dryRun = args.dryRun !== false
    const days = ttlDays(process.env[TTL_ENV])
    const out: Sweep = { closed: [], wouldClose: [], kept: [], partial: [], skipped: { recent: 0, active: 0, unknown: 0 } }
    if (days === 0) return ok(`The session sweep is disabled (${TTL_ENV}=0).`, { disabled: true, dryRun, ttlDays: 0, ...out })
    const cutoff = Date.now() - days * DAY_MS
    // A dry run leaves the sweep cursor where it is, so the real run then sees the same records.
    const candidates = await ctx.workspaces.closeCandidates(ctx.supervisor, new Date(cutoff), MAX_EXAMINED, { moveCursor: !dryRun })
    const run: SweepRun = { ctx, box: await ctx.box(), cutoff, dryRun, deleteBranch: args.deleteBranch === true, correlationId, out }
    for (const state of candidates.states) {
      if (out.closed.length + out.wouldClose.length >= MAX_CLOSED) break
      try {
        await sweepOne(run, state)
      } catch (error) {
        out.skipped.unknown++
        ctx.log.log("warn", "tools", "session sweep skipped a session", { sessionKey: state.sessionKey, correlationId, code: error instanceof DelegateError ? error.code : "unexpected" })
      }
    }
    const summary = sweepSummary(out, dryRun, days, candidates.states.length, candidates.otherBridge)
    return ok(summary, { dryRun, ttlDays: days, examined: candidates.states.length, ...out, legacyRecords: candidates.legacy, otherBoxRecords: candidates.otherBox, otherBridgeRecords: candidates.otherBridge })
  },
})
