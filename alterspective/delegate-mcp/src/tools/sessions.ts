// oc_start_session, oc_list_sessions, oc_status, oc_abort (technical-design §5).
// A session gets its own workspace clone (/sessions/<key>, branch delegate/<key>), the permission
// baseline for its profile, and metadata naming this bridge so it can be adopted after a restart.
import { z } from "zod"
import { SESSION_SUPERVISOR_KEY } from "../inbox/index.ts"
import type { SessionView } from "../shared/contracts.ts"
import { DelegateError } from "../shared/errors.ts"
import { expectOk } from "../shared/opencode-api.ts"
import { samePath } from "../supervisor/workspaces-exec.ts"
import type { Box, SessionRecord, ToolContext } from "./context.ts"
import { boxHead, refuseBusy } from "./core-box.ts"
import { SESSION_ID_RE, agentSchema, modelSchema, newSessionKey, ownSession, sessionIdSchema, webUrl, type RemoteSession, type SessionMetadata } from "./core-session.ts"
import { defineTool } from "./define.ts"
import { requireModel } from "./models.ts"
import { ok, untrusted } from "./shape.ts"

type StartArgs = { directory: string; title?: string; agent?: string; model?: string; profile?: "standard" | "readonly"; allowShared?: boolean }

async function createSession(ctx: ToolContext, box: Box, args: StartArgs, ws: { sessionKey: string; hostRepo: string; boxPath: string }, base: string | undefined, correlationId: string): Promise<string> {
  const profile = args.profile ?? "standard"
  const metadata: SessionMetadata = { [SESSION_SUPERVISOR_KEY]: ctx.supervisor, sessionKey: ws.sessionKey, hostRepo: ws.hostRepo, profile, ...(base ? { base } : {}), ...(args.model ? { model: args.model } : {}), ...(args.agent ? { agent: args.agent } : {}) }
  const body = { title: args.title ?? `delegate ${ws.sessionKey}`, permission: ctx.guard.permissionBaseline(profile), metadata }
  const created = expectOk(await box.api.call<{ id?: unknown }>({ method: "POST", path: "/session", directory: ws.boxPath, body, correlationId }), "create the session")
  if (typeof created.id !== "string" || !SESSION_ID_RE.test(created.id))
    throw new DelegateError("upstream_error", "The delegate server returned a session without a valid id.", "Retry oc_start_session; if it repeats, run oc_doctor.")
  return created.id
}

export const startSessionTool = defineTool({
  name: "oc_start_session",
  title: "Start a delegated OpenCode session",
  description:
    "Start an OpenCode session on a copy of a git repository: the repo is bundled into the sandbox, where the agent works on branch delegate/<key>. The owner's repo is never mounted or changed until oc_collect fetches that branch back. Refuses a second working session in the same repo unless allowShared.",
  input: {
    directory: z.string().min(1).max(1024).describe("The owner's repository (a folder under the allowed roots, e.g. C:\\GitHub\\my-repo)."),
    title: z.string().max(200).optional(),
    agent: agentSchema.optional().describe("OpenCode agent for the session, e.g. build (default) or plan."),
    model: modelSchema.optional().describe("Default model for this session's sends, as provider/model."),
    profile: z.enum(["standard", "readonly"]).optional().describe("Permission profile. readonly denies edits and asks before any shell command. Default standard."),
    allowShared: z.boolean().optional().describe("Allow this session while another one of ours is still working in the same repo."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const hostRepo = await ctx.workspaces.resolveRepo(args.directory)
    if (!args.allowShared) await refuseBusy(ctx, hostRepo, samePath)
    const box = await ctx.box()
    if (args.model) await requireModel(box.api, args.model, correlationId)
    const ws = await ctx.workspaces.open(hostRepo, newSessionKey())
    const base = await boxHead(ctx, ws.boxPath)
    const sessionID = await createSession(ctx, box, args, ws, base, correlationId)
    const record: SessionRecord = { sessionID, sessionKey: ws.sessionKey, hostRepo: ws.hostRepo, boxPath: ws.boxPath, branch: ws.branch, profile: args.profile ?? "standard", createdAt: new Date().toISOString(), base, model: args.model, agent: args.agent }
    ctx.sessions.set(sessionID, record)
    box.hub.track(sessionID, ws.boxPath)
    return ok(`Session ${sessionID} started on ${ws.branch}. Next: oc_send, then oc_wait.`, {
      sessionID, sessionKey: ws.sessionKey, branch: ws.branch, boxPath: ws.boxPath, hostRepo: ws.hostRepo, profile: record.profile, base,
      webUrl: webUrl(box.target, ws.boxPath, sessionID),
    })
  },
})

type ListedSession = RemoteSession & { project?: unknown }

async function listRemote(box: Box, correlationId: string): Promise<ListedSession[]> {
  const res = await box.api.call<ListedSession[]>({ path: "/experimental/session?roots=true&limit=200", correlationId })
  if (res.status !== 200 || !Array.isArray(res.data)) throw new DelegateError("upstream_error", "The delegate server failed to list its sessions.", "Retry; if it repeats, run oc_doctor.", `HTTP ${res.status}`)
  return res.data.filter((s) => typeof s.id === "string" && SESSION_ID_RE.test(s.id))
}

function listed(ctx: ToolContext, s: ListedSession) {
  const supervisor = typeof s.metadata?.supervisor === "string" && /^supervisor:[a-z0-9-]{1,40}$/.test(s.metadata.supervisor) ? s.metadata.supervisor : undefined
  return { sessionID: s.id, directory: typeof s.directory === "string" ? s.directory.slice(0, 200) : undefined, supervisor, mine: supervisor === ctx.supervisor, title: untrusted(s.title, 200), updated: s.time?.updated }
}

export const listSessionsTool = defineTool({
  name: "oc_list_sessions",
  title: "List delegated sessions",
  description: "List this bridge's sessions with their state, or (all:true) every top-level session in the sandbox with the bridge that owns it.",
  input: { all: z.boolean().optional().describe("Every session in the sandbox, not just this bridge's. Default false.") },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const box = await ctx.box()
    const remote = (await listRemote(box, correlationId)).map((s) => listed(ctx, s))
    const rows = args.all ? remote : remote.filter((s) => s.mine)
    const states = new Map<string, SessionView>()
    for (const row of rows) if (row.mine && ctx.sessions.has(row.sessionID)) states.set(row.sessionID, await box.hub.view(row.sessionID))
    const sessions = rows.map((row) => ({ ...row, state: states.get(row.sessionID)?.state, branch: ctx.sessions.get(row.sessionID)?.branch }))
    const gone = [...ctx.sessions.keys()].filter((id) => !rows.some((r) => r.sessionID === id))
    return ok(`${sessions.length} session${sessions.length === 1 ? "" : "s"}${args.all ? " in the sandbox" : " of this bridge"}.`, { supervisor: ctx.supervisor, sessions, ...(gone.length ? { missingFromServer: gone } : {}) })
  },
})

export const statusTool = defineTool({
  name: "oc_status",
  title: "Session state",
  description: "Current state of one of this bridge's sessions (or all of them): starting, busy, retry, needs_input, idle, error, aborted, not_started, unknown, not_found or server_down, with pending request ids.",
  input: { sessionID: sessionIdSchema.optional() },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    if (!args.sessionID && ctx.sessions.size === 0) return ok("This bridge has no sessions yet.", { sessions: [] })
    const box = await ctx.box()
    const ids = args.sessionID ? [(await ownSession(ctx, box, args.sessionID, correlationId)).record.sessionID] : [...ctx.sessions.keys()]
    const views = await Promise.all(ids.map((id) => box.hub.view(id)))
    const summary = views.map((v) => `${v.sessionID} ${v.state}`).join("; ")
    return ok(summary, { sessions: views })
  },
})

export const abortTool = defineTool({
  name: "oc_abort",
  title: "Stop a session's run",
  description: "Abort the current run of one of this bridge's sessions. The workspace and history are kept.",
  input: { sessionID: sessionIdSchema },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const box = await ctx.box()
    const { record } = await ownSession(ctx, box, args.sessionID, correlationId)
    const res = await box.api.call({ method: "POST", path: `/session/${record.sessionID}/abort`, directory: record.boxPath, correlationId })
    if (res.status < 200 || res.status >= 300) throw new DelegateError("upstream_error", "The delegate server failed to abort the session.", "Retry; check oc_status.", `HTTP ${res.status}`)
    return ok(`Session ${record.sessionID} aborted.`, { sessionID: record.sessionID, aborted: true })
  },
})
