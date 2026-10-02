// #72: oc_close_session and oc_cleanup. Nothing else removes finished delegated work: the box clone
// (/sessions/<key>), the OpenCode session, the host record and the fetched delegate/<key> branch.
// Both tools close only sessions whose host record names this bridge and this box
// (workspaces-close.ts re-checks that). Commits only the box has, and uncommitted files, are never
// deleted unless `force`; oc_cleanup never forces. The host branch goes only when merged (or forced
// on oc_close_session). Results carry session ids, keys and counts only.
import { z } from "zod"
import { DelegateError } from "../shared/errors.ts"
import type { SessionState } from "../shared/contracts.ts"
import type { CloseOutcome, ClosePlan, SessionRemoval } from "../supervisor/workspaces.ts"
import type { Box, ToolContext } from "./context.ts"
import { boxPathOf, checkSessionId, ownedStates, sessionIdSchema, type RemoteSession } from "./core-session.ts"
import { defineTool } from "./define.ts"
import { ok } from "./shape.ts"

export const TTL_ENV = "OPENCODE_DELEGATE_SESSION_TTL_DAYS"
export const DEFAULT_TTL_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000
/** Records looked at per oc_cleanup call (oldest first), and sessions closed per call. */
const MAX_EXAMINED = 20
const MAX_CLOSED = 10
/** States in which a session may still change its clone: never closed without force, never swept. */
const ACTIVE: ReadonlySet<SessionState> = new Set<SessionState>(["starting", "busy", "retry", "needs_input", "unknown", "server_down"])

/** OPENCODE_DELEGATE_SESSION_TTL_DAYS: whole days, 0 disables; unset is 14. */
export function ttlDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TTL_DAYS
  if (!/^\d{1,4}$/.test(raw.trim())) throw new DelegateError("invalid_input", `${TTL_ENV} must be a whole number of days (0 disables the sweep).`, `Set ${TTL_ENV} to e.g. 14, or unset it.`)
  return Number(raw.trim())
}

type Located = { sessionKey: string; remote?: RemoteSession }

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

const notOurs = (sessionID: string) =>
  new DelegateError("not_found", `Session ${sessionID} is not one of this bridge's sessions.`, "Use oc_list_sessions to see this bridge's sessions.")

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

function uncollectedError(sessionID: string, outcome: Pick<CloseOutcome, "refused" | "uncollectedCommits" | "uncommittedPaths">): DelegateError {
  if (outcome.refused === "check_failed")
    return new DelegateError("upstream_error", `Could not check session ${sessionID}'s copy for uncollected work, so nothing was deleted.`, "Retry; run oc_doctor if the sandbox is down. force: true deletes without the check.")
  const lost = [outcome.uncollectedCommits ? plural(outcome.uncollectedCommits, "uncollected commit") : "", outcome.uncommittedPaths ? plural(outcome.uncommittedPaths, "uncommitted file") : ""].filter(Boolean).join(" and ")
  return new DelegateError("directory_busy", `Session ${sessionID} still has ${lost} in the sandbox, so nothing was deleted.`, "Collect them first with oc_collect (ask the agent to commit loose files), or pass force: true to delete them.")
}

/** The session's state when the sandbox still has it (undefined when it is gone). */
async function liveState(box: Box, located: Located, sessionID: string): Promise<SessionState | undefined> {
  return located.remote ? (await box.hub.view(sessionID)).state : undefined
}

function busyError(sessionID: string, state: SessionState): DelegateError {
  return new DelegateError("directory_busy", `Session ${sessionID} is ${state}, so it was not closed.`, "Wait for it with oc_wait (or stop it with oc_abort), then close it; force: true aborts it first.")
}

async function abortFirst(ctx: ToolContext, box: Box, located: Located, sessionID: string, correlationId: string): Promise<void> {
  const res = await box.api.call<unknown>({ method: "POST", path: `/session/${sessionID}/abort`, directory: boxPathOf(located.sessionKey), correlationId })
  ctx.log.log("info", "tools", "aborted a session before closing it", { sessionID, correlationId, status: res.status })
}

function closeSummary(o: CloseOutcome): string {
  const lost = o.uncollectedCommits || o.uncommittedPaths ? ` Deleted (force) ${plural(o.uncollectedCommits, "uncollected commit")} and ${plural(o.uncommittedPaths, "uncommitted file")}.` : ""
  if (o.closed) return `Session ${o.sessionID} closed: session ${o.session}, copy ${o.clone}, record removed, branch ${o.branch}.${lost}`
  return `Session ${o.sessionID} only partly closed (session ${o.session}, copy ${o.clone}, branch ${o.branch}, record ${o.record}); the host record was kept, so oc_close_session can be retried.${lost}`
}

export const closeSessionTool = defineTool({
  name: "oc_close_session",
  title: "Close a finished session",
  description:
    "Delete one of this bridge's finished sessions: the OpenCode session, its copy in the sandbox and the bridge's host record. Refuses while the session is busy or needs input, and while its copy has commits no host branch has (run oc_collect first) or uncommitted files, unless force: true (which aborts a running session and deletes that work). " +
    "deleteBranch: true also deletes the host branch delegate/<key>, only if it is merged into the repository's HEAD or the session's base (force: true deletes it unmerged); a branch checked out anywhere is never deleted, and no other branch is touched.",
  input: {
    sessionID: sessionIdSchema,
    deleteBranch: z.boolean().optional().describe("Also delete the host branch delegate/<key> when it is merged. Default false."),
    force: z.boolean().optional().describe("Abort a running session and delete uncollected work and an unmerged branch. Default false."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const force = args.force === true
    const box = await ctx.box()
    const located = await locate(ctx, box, args.sessionID, correlationId)
    const owner = { supervisor: ctx.supervisor, sessionID: args.sessionID }
    // Ownership and the loss check first (reads only): nothing is sent for a session that is not ours.
    const plan: ClosePlan = await ctx.workspaces.inspectClose(located.sessionKey, owner, { deleteBranch: false })
    const state = await liveState(box, located, args.sessionID)
    const aborted = state !== undefined && ACTIVE.has(state)
    if (aborted && !force) throw busyError(args.sessionID, state)
    if (!plan.safe && !force) throw uncollectedError(args.sessionID, { refused: plan.reason, uncollectedCommits: plan.uncollectedCommits, uncommittedPaths: plan.uncommittedPaths })
    if (aborted) await abortFirst(ctx, box, located, args.sessionID, correlationId)
    const outcome = await ctx.workspaces.closeSession(located.sessionKey, owner, { force, deleteBranch: args.deleteBranch === true }, sessionDeleter(box, args.sessionID, located.sessionKey, correlationId))
    if (outcome.refused && outcome.session === "kept") throw uncollectedError(args.sessionID, outcome)
    if (outcome.session !== "kept") ctx.sessions.delete(args.sessionID)
    return ok(closeSummary(outcome), { ...outcome, aborted })
  },
})

type Row = { sessionKey: string; reason: string; uncollectedCommits: number; uncommittedPaths: number }
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

/** Why a candidate is not swept now, or undefined when it is stale and idle. */
async function notStale(run: SweepRun, state: Candidate): Promise<keyof Sweep["skipped"] | undefined> {
  const active = await lastActive(run, state)
  if (!active) return "unknown"
  if (active.at >= run.cutoff) return "recent"
  if (active.present && ACTIVE.has((await run.box.hub.view(state.sessionID)).state)) return "active"
  return undefined
}

function keep(out: Sweep, sessionKey: string, reason: string, o: { uncollectedCommits: number; uncommittedPaths: number }): void {
  out.kept.push({ sessionKey, reason, uncollectedCommits: o.uncollectedCommits, uncommittedPaths: o.uncommittedPaths })
}

/** One stale candidate: listed (dry run) or closed with every guard and never forced. */
async function sweepOne(run: SweepRun, state: Candidate): Promise<void> {
  const { ctx, out } = run
  const skip = await notStale(run, state)
  if (skip) {
    out.skipped[skip]++
    return
  }
  const owner = { supervisor: ctx.supervisor, sessionID: state.sessionID }
  if (run.dryRun) {
    const plan = await ctx.workspaces.inspectClose(state.sessionKey, owner, { deleteBranch: run.deleteBranch })
    if (plan.safe) out.wouldClose.push(state.sessionKey)
    else keep(out, state.sessionKey, plan.reason ?? "check_failed", plan)
    return
  }
  const o = await ctx.workspaces.closeSession(state.sessionKey, owner, { force: false, deleteBranch: run.deleteBranch }, sessionDeleter(run.box, state.sessionID, state.sessionKey, run.correlationId))
  if (o.session !== "kept") ctx.sessions.delete(state.sessionID)
  if (o.closed) out.closed.push(state.sessionKey)
  else if (o.refused && o.session === "kept") keep(out, state.sessionKey, o.refused, o)
  else out.partial.push(state.sessionKey)
}

export const cleanupTool = defineTool({
  name: "oc_cleanup",
  title: "Sweep stale sessions",
  description:
    `Find this bridge's sessions idle longer than ${TTL_ENV} days (default ${DEFAULT_TTL_DAYS}; 0 disables) and close them with oc_close_session's guards, never forced: a session with uncollected commits or uncommitted files, or one that is busy or needs input, is kept. ` +
    `dryRun (default true) only lists what would be removed. At most ${MAX_EXAMINED} records are looked at and ${MAX_CLOSED} sessions closed per call, oldest first. deleteBranch: true also deletes merged delegate/<key> branches.`,
  input: {
    dryRun: z.boolean().optional().describe("Only report what would be removed. Default true."),
    deleteBranch: z.boolean().optional().describe("Also delete each closed session's host branch when it is merged. Default false."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const dryRun = args.dryRun !== false
    const days = ttlDays(process.env[TTL_ENV])
    const out: Sweep = { closed: [], wouldClose: [], kept: [], partial: [], skipped: { recent: 0, active: 0, unknown: 0 } }
    if (days === 0) return ok(`The session sweep is disabled (${TTL_ENV}=0).`, { disabled: true, dryRun, ttlDays: 0, ...out })
    const cutoff = Date.now() - days * DAY_MS
    const candidates = await ctx.workspaces.closeCandidates(ctx.supervisor, new Date(cutoff), MAX_EXAMINED)
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
    const done = dryRun ? `${plural(out.wouldClose.length, "session")} would be closed` : `${plural(out.closed.length, "session")} closed`
    const summary = `${done}; ${out.kept.length} kept for uncollected work or failed checks (older than ${days} days, ${plural(candidates.states.length, "record")} looked at).`
    return ok(summary, { dryRun, ttlDays: days, examined: candidates.states.length, ...out, legacyRecords: candidates.legacy, otherBoxRecords: candidates.otherBox })
  },
})
