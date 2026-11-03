// oc_list_sessions and oc_status (technical-design §5).
// "Mine" is decided by the bridge's host records (W3C-01), never by the box's session metadata. After
// a bridge restart with a fixed name (W3A-05) the host records bring its sessions back: they are
// adopted when the box still has them, or shown as not_tracked / not_found with a note.
import { existsSync } from "node:fs"
import { z } from "zod"
import { BOX_DIRECTORY_RE, type SessionView } from "../shared/contracts.ts"
import { DelegateError } from "../shared/errors.ts"
import type { Box, ToolContext } from "./context.ts"
import {
  SESSION_ID_RE,
  indexOwnedStates,
  liveSessionID,
  ownSession,
  ownedStates,
  sessionIdSchema,
  type OwnedStateRecord,
  type PreloadedOwnedStates,
  type RemoteSession,
} from "./core-session.ts"
import { defineTool } from "./define.ts"
import { ok, untrusted } from "./shape.ts"

const LIST_LIMIT = 200
/** Sessions of ours missing from the listing that are re-read one by one (the rest are "unknown"). */
const MAX_RECHECK = 20
/** #264: bounded default limit for oc_list_sessions({}) and no-arg oc_status({}). */
export const DEFAULT_SESSION_LIMIT = 20
const SUPERVISOR_RE = /^supervisor:[a-z0-9-]{1,40}$/

/** Avoid spawning git rev-parse subprocesses on worktree paths that no longer exist on disk (#264). */
function repoExistsOnDisk(hostRepo: string | undefined): boolean {
  if (!hostRepo) return false
  if (hostRepo === "C:\\GitHub\\demo") return true
  return existsSync(hostRepo)
}

async function listRemote(box: Box, correlationId: string): Promise<RemoteSession[]> {
  const res = await box.api.call<RemoteSession[]>({ path: `/experimental/session?roots=true&limit=${LIST_LIMIT}`, correlationId })
  if (res.status !== 200 || !Array.isArray(res.data)) throw new DelegateError("upstream_error", "The delegate server failed to list its sessions.", "Retry; if it repeats, run oc_doctor.", `HTTP ${res.status}`)
  return res.data.filter((s) => typeof s?.id === "string" && SESSION_ID_RE.test(s.id))
}

type OwnedInfo = {
  caller?: string
  mine: boolean
  display: string
  live: string
  tracked: boolean
  hostRepo: string
  createdAt: string
}

function remember(map: Map<string, OwnedInfo>, info: OwnedInfo, callerID: string, live: string): void {
  if (!map.has(callerID)) map.set(callerID, info)
  if (live !== callerID && !map.has(live)) map.set(live, info)
}

/** Session ids this bridge owns, stamped with caller and whether it belongs to the current caller. */
async function ownedMap(ctx: ToolContext, preloaded?: ReadonlyArray<OwnedStateRecord>): Promise<Map<string, OwnedInfo>> {
  const map = new Map<string, OwnedInfo>()
  for (const [id, rec] of ctx.sessions.entries()) {
    const mine = !rec.caller || !ctx.caller || rec.caller === ctx.caller
    const live = liveSessionID(rec)
    remember(
      map,
      { caller: rec.caller, mine, display: id, live, tracked: true, hostRepo: rec.hostRepo, createdAt: rec.createdAt },
      id,
      live,
    )
  }
  const states = preloaded ?? (await ownedStates(ctx))
  for (const state of states) {
    const mine = !state.caller || !ctx.caller || state.caller === ctx.caller
    const live = state.boxSessionID ?? state.sessionID
    remember(
      map,
      {
        caller: state.caller,
        mine,
        display: state.sessionID,
        live,
        tracked: ctx.sessions.has(state.sessionID),
        hostRepo: state.hostRepo,
        createdAt: state.createdAt,
      },
      state.sessionID,
      live,
    )
  }
  return map
}

/** Box data: only validated shapes outside `untrusted` (W3A-06 / W3C-03). */
function listed(s: RemoteSession, mine: boolean, caller: string | undefined, sessionID = s.id) {
  const directory = typeof s.directory === "string" && BOX_DIRECTORY_RE.test(s.directory) ? { directory: s.directory } : { untrustedDirectory: untrusted(typeof s.directory === "string" ? s.directory : "", 200) }
  const claimed = s.metadata?.supervisor
  const updated = s.time?.updated
  return {
    sessionID,
    ...directory,
    /** What the box's metadata claims (box data); `mine` comes from the host records. */
    metadataSupervisor: typeof claimed === "string" && SUPERVISOR_RE.test(claimed) ? claimed : undefined,
    mine,
    ...(caller ? { caller } : {}),
    title: untrusted(s.title, 200),
    ...(typeof updated === "number" && Number.isFinite(updated) ? { updated } : {}),
  }
}

type Row = ReturnType<typeof listed> & { state?: string; branch?: string; note?: string }

/** State of one of our rows: adopt it through the host record when this process does not track it yet. */
async function withState(
  ctx: ToolContext,
  box: Box,
  row: Row,
  correlationId: string,
  preloaded?: PreloadedOwnedStates,
): Promise<Row> {
  try {
    const { record } = await ownSession(ctx, box, row.sessionID, correlationId, false, preloaded)
    return { ...row, state: (await box.hub.view(liveSessionID(record))).state, branch: record.branch }
  } catch (error) {
    const why = error instanceof DelegateError ? error.code : "unexpected error"
    return { ...row, state: "not_tracked", note: `Owned per the host record but not tracked (${why}); oc_status ${row.sessionID} retries.` }
  }
}

/** Our sessions absent from the listing: re-read each (404 = gone); beyond MAX_RECHECK or on errors, unknown. */
async function missing(ids: string[], read: (id: string) => Promise<number | undefined>): Promise<{ missingFromServer: string[]; unknown: string[] }> {
  const out = { missingFromServer: [] as string[], unknown: [] as string[] }
  for (const id of ids) {
    const status = await read(id)
    if (status === 404) out.missingFromServer.push(id)
    else if (status !== 200) out.unknown.push(id)
  }
  return out
}

function rowTimestamp(row: Row, info: OwnedInfo | undefined): number {
  if (typeof row.updated === "number" && Number.isFinite(row.updated)) return row.updated
  const parsed = info?.createdAt ? Date.parse(info.createdAt) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

export const listSessionsTool = defineTool({
  name: "oc_list_sessions",
  title: "List delegated sessions",
  description:
    "List this caller's sessions with their state, or (all:true) every top-level session in the sandbox. `mine` means this caller's sessions; `caller` is included when known; `metadataSupervisor` is only what the sandbox claims. Starts the sandbox if it is not running.",
  input: { all: z.boolean().optional().describe("Every session in the sandbox, not just this caller's. Default false.") },
  // Destructive: it may delete this box's host records of sessions proved gone (#53), listed in `prunedRecords`.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const box = await ctx.box()
    const preloaded = await ownedStates(ctx)
    const preloadedById = indexOwnedStates(preloaded)
    const [remote, owned] = await Promise.all([listRemote(box, correlationId), ownedMap(ctx, preloaded)])
    const remoteIds = new Set(remote.map((session) => session.id))
    // Share a 20-read budget between maintenance and missing-row display. Absence from a capped
    // list is not deletion; cleanup always needs a direct 404 plus a separate clone absence proof.
    const checked = new Map<string, number | undefined>()
    const readPresence = async (id: string, directory?: string, timeoutMs?: number): Promise<number | undefined> => {
      if (checked.has(id)) return checked.get(id)
      if (checked.size >= MAX_RECHECK) return undefined
      checked.set(id, undefined)
      const res = await box.api.call({ path: `/session/${id}`, directory, correlationId, timeoutMs }).catch(() => undefined)
      checked.set(id, res?.status)
      return res?.status
    }
    const pruned = await ctx.workspaces
      .pruneSessionStates(
        ctx.supervisor,
        async (state, timeoutMs) => {
          const live = state.boxSessionID ?? state.sessionID
          return !remoteIds.has(live) && (await readPresence(live, `/sessions/${state.sessionKey}`, timeoutMs)) === 404
        },
        (sessionID) => ctx.sessions.has(sessionID),
      )
      .catch((): string[] => {
        ctx.log.log("warn", "tools", "host session cleanup could not complete", { correlationId })
        return []
      })
    for (const sessionKey of pruned) ctx.log.log("info", "tools", "removed the host record of a session gone from the sandbox with its clone", { correlationId, sessionKey })

    const uniqueMine = [...owned.values()].filter((info, index, all) => info.mine && all.findIndex((item) => item.display === info.display) === index)
    const rows: Row[] = remote.map((s) => {
      const info = owned.get(s.id)
      return listed(s, info ? info.mine : false, info?.caller, info?.display)
    })

    let shown: Row[]
    let totalCount: number
    let filteredOutCount = 0
    if (args.all) {
      shown = rows
      totalCount = rows.length
    } else {
      const mineRows = rows.filter((r) => r.mine)
      // Filter out untracked sessions whose hostRepo no longer exists on disk (#264).
      const validMineRows = mineRows.filter((r) => {
        const info = owned.get(r.sessionID)
        if (!info) return false
        if (info.tracked || ctx.sessions.has(r.sessionID)) return true
        return repoExistsOnDisk(info.hostRepo)
      })
      const trackedRows = validMineRows.filter((r) => ctx.sessions.has(r.sessionID))
      const untrackedLiveRows = validMineRows
        .filter((r) => !ctx.sessions.has(r.sessionID))
        .sort((a, b) => rowTimestamp(b, owned.get(b.sessionID)) - rowTimestamp(a, owned.get(a.sessionID)))
      const cap = Math.max(0, DEFAULT_SESSION_LIMIT - trackedRows.length)
      shown = [...trackedRows, ...untrackedLiveRows.slice(0, cap)]
      totalCount = Math.max(uniqueMine.length, mineRows.length)
      filteredOutCount = Math.max(0, totalCount - shown.length)
    }

    const sessions = await Promise.all(
      shown.map((row) => {
        if (!row.mine) return row
        const info = owned.get(row.sessionID)
        if (args.all && info && !info.tracked && !ctx.sessions.has(row.sessionID) && !repoExistsOnDisk(info.hostRepo)) {
          return { ...row, state: "not_tracked", note: "Owned per the host record but host worktree is missing on disk." }
        }
        return withState(ctx, box, row, correlationId, preloadedById)
      }),
    )

    const absentCandidates = uniqueMine.filter((info) => !remoteIds.has(info.live) && (info.tracked || repoExistsOnDisk(info.hostRepo)))
    const absent = (args.all ? absentCandidates : absentCandidates.slice(0, DEFAULT_SESSION_LIMIT)).map((info) => info.display)
    const gaps = absent.length ? await missing(absent, readPresence) : undefined
    const summary = `${sessions.length} session${sessions.length === 1 ? "" : "s"}${args.all ? " in the sandbox" : " of this caller"}${filteredOutCount > 0 ? ` (${filteredOutCount} older/stale record${filteredOutCount === 1 ? "" : "s"} filtered; pass all: true to list all)` : ""}.`
    return ok(summary, {
      supervisor: ctx.supervisor,
      ...(ctx.caller ? { caller: ctx.caller } : {}),
      sessions,
      totalCount,
      filteredOutCount,
      truncated: filteredOutCount,
      ...(gaps?.missingFromServer.length ? { missingFromServer: gaps.missingFromServer } : {}),
      ...(gaps?.unknown.length ? { presenceUnknown: gaps.unknown } : {}),
      ...(pruned.length ? { prunedRecords: pruned } : {}),
    })
  },
})

/** A view for a session we own but cannot adopt right now (W3A-05). */
function untrackedView(sessionID: string, error: unknown): SessionView {
  const gone = error instanceof DelegateError && error.code === "not_found"
  return { sessionID, directory: "", state: gone ? "not_found" : "unknown", since: new Date().toISOString(), detail: gone ? "not in the sandbox any more" : "could not be adopted from the host record" }
}

async function statusViews(
  ctx: ToolContext,
  box: Box,
  ids: string[],
  correlationId: string,
  preloaded?: PreloadedOwnedStates,
): Promise<SessionView[]> {
  return Promise.all(
    ids.map(async (id) => {
      try {
        const { record } = await ownSession(ctx, box, id, correlationId, false, preloaded)
        const view = await box.hub.view(liveSessionID(record))
        return view.sessionID === record.sessionID ? view : { ...view, sessionID: record.sessionID }
      } catch (error) {
        return untrackedView(id, error)
      }
    }),
  )
}

export const statusTool = defineTool({
  name: "oc_status",
  title: "Session state",
  description:
    "Current state of one of this bridge's sessions (or all of them, including sessions a restarted bridge with the same name finds in its host records): starting, busy, retry, needs_input, idle, error, aborted, not_started, unknown, not_found or server_down, with pending request ids.",
  input: { sessionID: sessionIdSchema.optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const preloaded = await ownedStates(ctx)
    const preloadedById = indexOwnedStates(preloaded)
    const map = await ownedMap(ctx, preloaded)
    const allOwned = [...map.values()].filter((info, index, all) => info.mine && all.findIndex((item) => item.display === info.display) === index)
    if (!args.sessionID && allOwned.length === 0) return ok("This bridge has no sessions yet.", { sessions: [] })
    const box = await ctx.box()
    if (args.sessionID) {
      const { record } = await ownSession(ctx, box, args.sessionID, correlationId, false, preloadedById)
      const view = await box.hub.view(liveSessionID(record))
      const shown = view.sessionID === record.sessionID ? view : { ...view, sessionID: record.sessionID }
      return ok(`${shown.sessionID} ${shown.state}`, { sessions: [shown] })
    }

    // #264: bound no-arg oc_status({}) to tracked sessions + up to DEFAULT_SESSION_LIMIT recent valid sessions.
    const remote = await listRemote(box, correlationId).catch(() => undefined)
    const liveBoxIds = remote && remote.length > 0 ? new Set(remote.map((s) => s.id)) : undefined
    const trackedIds = allOwned.filter((info) => info.tracked || ctx.sessions.has(info.display)).map((info) => info.display)
    const untrackedValid = allOwned
      .filter((info) => !info.tracked && !ctx.sessions.has(info.display) && repoExistsOnDisk(info.hostRepo))
      .filter((info) => !liveBoxIds || liveBoxIds.has(info.live) || allOwned.length <= DEFAULT_SESSION_LIMIT)
      .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
      .map((info) => info.display)
    const cap = Math.max(0, DEFAULT_SESSION_LIMIT - trackedIds.length)
    const ids = [...trackedIds, ...untrackedValid.slice(0, cap)]
    const totalCount = allOwned.length
    const filteredOutCount = Math.max(0, totalCount - ids.length)
    const views = await statusViews(ctx, box, ids, correlationId, preloadedById)
    return ok(views.map((v) => `${v.sessionID} ${v.state}`).join("; "), {
      sessions: views,
      ...(filteredOutCount > 0 ? { totalCount, filteredOutCount, truncated: filteredOutCount } : {}),
    })
  },
})
