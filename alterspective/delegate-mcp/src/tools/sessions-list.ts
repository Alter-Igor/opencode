// oc_list_sessions and oc_status (technical-design §5).
// "Mine" is decided by the bridge's host records (W3C-01), never by the box's session metadata. After
// a bridge restart with a fixed name (W3A-05) the host records bring its sessions back: they are
// adopted when the box still has them, or shown as not_tracked / not_found with a note.
import { z } from "zod"
import { BOX_DIRECTORY_RE, type SessionView } from "../shared/contracts.ts"
import { DelegateError } from "../shared/errors.ts"
import type { Box, ToolContext } from "./context.ts"
import { SESSION_ID_RE, ownSession, ownedStates, sessionIdSchema, type RemoteSession } from "./core-session.ts"
import { defineTool } from "./define.ts"
import { ok, untrusted } from "./shape.ts"

const LIST_LIMIT = 200
/** Sessions of ours missing from the listing that are re-read one by one (the rest are "unknown"). */
const MAX_RECHECK = 20
const SUPERVISOR_RE = /^supervisor:[a-z0-9-]{1,40}$/

async function listRemote(box: Box, correlationId: string): Promise<RemoteSession[]> {
  const res = await box.api.call<RemoteSession[]>({ path: `/experimental/session?roots=true&limit=${LIST_LIMIT}`, correlationId })
  if (res.status !== 200 || !Array.isArray(res.data)) throw new DelegateError("upstream_error", "The delegate server failed to list its sessions.", "Retry; if it repeats, run oc_doctor.", `HTTP ${res.status}`)
  return res.data.filter((s) => typeof s?.id === "string" && SESSION_ID_RE.test(s.id))
}

/** Session ids this bridge owns: started or adopted in this process, or named by a host record. */
async function ownedIds(ctx: ToolContext): Promise<Set<string>> {
  const ids = new Set(ctx.sessions.keys())
  for (const state of await ownedStates(ctx)) ids.add(state.sessionID)
  return ids
}

/** Box data: only validated shapes outside `untrusted` (W3A-06 / W3C-03). */
function listed(s: RemoteSession, mine: boolean) {
  const directory = typeof s.directory === "string" && BOX_DIRECTORY_RE.test(s.directory) ? { directory: s.directory } : { untrustedDirectory: untrusted(typeof s.directory === "string" ? s.directory : "", 200) }
  const claimed = s.metadata?.supervisor
  const updated = s.time?.updated
  return {
    sessionID: s.id,
    ...directory,
    /** What the box's metadata claims (box data); `mine` comes from the host records. */
    metadataSupervisor: typeof claimed === "string" && SUPERVISOR_RE.test(claimed) ? claimed : undefined,
    mine,
    title: untrusted(s.title, 200),
    ...(typeof updated === "number" && Number.isFinite(updated) ? { updated } : {}),
  }
}

type Row = ReturnType<typeof listed> & { state?: string; branch?: string; note?: string }

/** State of one of our rows: adopt it through the host record when this process does not track it yet. */
async function withState(ctx: ToolContext, box: Box, row: Row, correlationId: string): Promise<Row> {
  try {
    const { record } = await ownSession(ctx, box, row.sessionID, correlationId)
    return { ...row, state: (await box.hub.view(record.sessionID)).state, branch: record.branch }
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

export const listSessionsTool = defineTool({
  name: "oc_list_sessions",
  title: "List delegated sessions",
  description:
    "List this bridge's sessions with their state, or (all:true) every top-level session in the sandbox. `mine` comes from the bridge's own host records; `metadataSupervisor` is only what the sandbox claims. Starts the sandbox if it is not running.",
  input: { all: z.boolean().optional().describe("Every session in the sandbox, not just this bridge's. Default false.") },
  // Destructive: it may delete this box's host records of sessions proved gone (#53), listed in `prunedRecords`.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const box = await ctx.box()
    const [remote, owned] = await Promise.all([listRemote(box, correlationId), ownedIds(ctx)])
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
        async (state, timeoutMs) => !remote.some((session) => session.id === state.sessionID) && (await readPresence(state.sessionID, `/sessions/${state.sessionKey}`, timeoutMs)) === 404,
        (sessionID) => ctx.sessions.has(sessionID),
      )
      .catch((): string[] => {
        ctx.log.log("warn", "tools", "host session cleanup could not complete", { correlationId })
        return []
      })
    for (const sessionKey of pruned) ctx.log.log("info", "tools", "removed the host record of a session gone from the sandbox with its clone", { correlationId, sessionKey })
    const rows: Row[] = remote.map((s) => listed(s, owned.has(s.id)))
    const shown = args.all ? rows : rows.filter((r) => r.mine)
    const sessions = await Promise.all(shown.map((row) => (row.mine ? withState(ctx, box, row, correlationId) : row)))
    const absent = [...owned].filter((id) => !remote.some((s) => s.id === id))
    const gaps = absent.length ? await missing(absent, readPresence) : undefined
    const summary = `${sessions.length} session${sessions.length === 1 ? "" : "s"}${args.all ? " in the sandbox" : " of this bridge"}.`
    return ok(summary, { supervisor: ctx.supervisor, sessions, ...(gaps?.missingFromServer.length ? { missingFromServer: gaps.missingFromServer } : {}), ...(gaps?.unknown.length ? { presenceUnknown: gaps.unknown } : {}), ...(pruned.length ? { prunedRecords: pruned } : {}) })
  },
})

/** A view for a session we own but cannot adopt right now (W3A-05). */
function untrackedView(sessionID: string, error: unknown): SessionView {
  const gone = error instanceof DelegateError && error.code === "not_found"
  return { sessionID, directory: "", state: gone ? "not_found" : "unknown", since: new Date().toISOString(), detail: gone ? "not in the sandbox any more" : "could not be adopted from the host record" }
}

async function statusViews(ctx: ToolContext, box: Box, ids: string[], correlationId: string): Promise<SessionView[]> {
  return Promise.all(
    ids.map(async (id) => {
      try {
        const { record } = await ownSession(ctx, box, id, correlationId)
        return await box.hub.view(record.sessionID)
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
    const ids = args.sessionID ? [args.sessionID] : [...(await ownedIds(ctx))]
    if (ids.length === 0) return ok("This bridge has no sessions yet.", { sessions: [] })
    const box = await ctx.box()
    if (args.sessionID) {
      const { record } = await ownSession(ctx, box, args.sessionID, correlationId)
      const view = await box.hub.view(record.sessionID)
      return ok(`${view.sessionID} ${view.state}`, { sessions: [view] })
    }
    const views = await statusViews(ctx, box, ids, correlationId)
    return ok(views.map((v) => `${v.sessionID} ${v.state}`).join("; "), { sessions: views })
  },
})
