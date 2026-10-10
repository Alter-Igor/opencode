// oc_start_session and oc_abort (technical-design §5). oc_list_sessions and oc_status: sessions-list.ts.
// A session gets its own workspace clone (/sessions/<key>, branch delegate/<key>), the permission
// baseline for its profile, and a host-only record (workspaces-state.ts) naming its session id and
// this bridge, which is what lets a restarted bridge with the same name adopt it (W3C-01). The
// session's metadata carries only the lookup key for that record.
// `keystone` (R4-01) narrows a session to a subset of the box-wide Keystone set with OpenCode
// permission rules. That is a convenience, not a wall: in-box code can still use every connection
// of the box-wide set (oc_server_restart {keystone} sets that, and front enforces it).
import { z } from "zod"
import { SESSION_SUPERVISOR_KEY } from "../inbox/index.ts"
import { recordStart } from "../reporting/hooks.ts"
import { CEILING_ENV, ceilingOf, enforceCeiling } from "../shared/keystone-policy.ts"
import { DelegateError } from "../shared/errors.ts"
import { CONNECTION_ID, MAX_CONNECTIONS, keystoneIds, readKeystoneSet } from "../shared/keystone.ts"
import { expectOk } from "../shared/opencode-api.ts"
import type { OpenedWorkspace } from "../supervisor/workspaces.ts"
import { samePath } from "../supervisor/workspaces-exec.ts"
import type { Box, SessionRecord, ToolContext } from "./context.ts"
import { refuseBusy } from "./core-box.ts"
import { SESSION_ID_RE, agentSchema, modelSchema, newSessionKey, ownSession, sessionIdSchema, webUrl, type SessionMetadata } from "./core-session.ts"
import { defineTool } from "./define.ts"
import { fetchModels, pickRoleModel, requireModel } from "./models.ts"
import { ok } from "./shape.ts"

export { listSessionsTool, statusTool } from "./sessions-list.ts"

type StartArgs = { directory: string; title?: string; agent?: string; model?: string; profile?: "standard" | "readonly"; allowShared?: boolean; keystone?: string[] }

/** The narrowing list, checked to be a subset of the box-wide set in force now; undefined = no narrowing. */
export function sessionKeystone(ctx: ToolContext, requested: readonly string[] | undefined): string[] | undefined {
  const saved = readKeystoneSet(ctx.config.home, ctx.config.keystoneConnections)
  let ceiling: string[]
  try {
    ceiling = ceilingOf(ctx.config)
  } catch {
    ceiling = []
  }
  const allowedInBox = saved.connections.filter((id) => ceiling.includes(id))

  if (requested === undefined) {
    const outside = saved.connections.filter((id) => !ceiling.includes(id))
    if (outside.length) {
      throw new DelegateError(
        "policy_violation",
        `The saved Keystone set in the sandbox contains connection${outside.length === 1 ? "" : "s"} (${outside.join(", ")}) outside the owner's allowed list (${CEILING_ENV}).`,
        `To start a session without interrupting other bridges, pass keystone: [${allowedInBox.map((s) => `"${s}"`).join(", ")}] to oc_start_session. To change the box-wide set, call oc_server_restart {keystone: [...]}.`,
        `outside ceiling: ${outside.join(", ")}`,
      )
    }
    return undefined
  }

  const ids = keystoneIds(requested)
  const outside = ids.filter((id) => !saved.connections.includes(id))
  if (outside.length)
    throw new DelegateError("invalid_input", `The sandbox does not offer Keystone connection${outside.length === 1 ? "" : "s"} ${outside.join(", ")}.`, `Choose from ${allowedInBox.join(", ") || "(none)"}, or add them to the box with oc_server_restart {keystone}.`)
  enforceCeiling(ids, ctx.config)
  return ids
}

async function createSession(ctx: ToolContext, box: Box, args: StartArgs, ws: OpenedWorkspace, correlationId: string): Promise<string> {
  const profile = args.profile ?? "standard"
  const metadata: SessionMetadata = { [SESSION_SUPERVISOR_KEY]: ctx.supervisor, sessionKey: ws.sessionKey }
  const body = { title: args.title ?? `delegate ${ws.sessionKey}`, permission: ctx.guard.permissionBaseline(profile, args.keystone), metadata }
  const created = expectOk(await box.api.call<{ id?: unknown }>({ method: "POST", path: "/session", directory: ws.boxPath, body, correlationId }), "create the session")
  if (typeof created.id !== "string" || !SESSION_ID_RE.test(created.id))
    throw new DelegateError("upstream_error", "The delegate server returned a session without a valid id.", "Retry oc_start_session; if it repeats, run oc_doctor.")
  return created.id
}

/** W3A-14: a start that failed after the clone was made leaves nothing behind (best effort, never throws). */
async function abandon(ctx: ToolContext, box: Box, ws: OpenedWorkspace, sessionID: string | undefined, correlationId: string): Promise<void> {
  if (sessionID) await box.api.call({ method: "DELETE", path: `/session/${sessionID}`, directory: ws.boxPath, correlationId }).catch(() => undefined)
  await ctx.workspaces.discard(ws.sessionKey).catch(() => undefined)
  ctx.log.log("warn", "tools", "session start failed; workspace discarded", { sessionKey: ws.sessionKey, correlationId })
}

async function startIn(ctx: ToolContext, box: Box, args: StartArgs, ws: OpenedWorkspace, correlationId: string): Promise<SessionRecord> {
  const profile = args.profile ?? "standard"
  let sessionID: string | undefined
  try {
    sessionID = await createSession(ctx, box, args, ws, correlationId)
    const extra = {
      ...(args.model ? { model: args.model } : {}),
      ...(args.agent ? { agent: args.agent } : {}),
      ...(args.keystone ? { keystone: args.keystone } : {}),
      ...(ctx.caller ? { caller: ctx.caller } : {}),
    }
    const state = await ctx.workspaces.bindSession(ws.sessionKey, { sessionID, profile, supervisor: ctx.supervisor, ...extra })
    return { sessionID, sessionKey: ws.sessionKey, hostRepo: ws.hostRepo, boxPath: ws.boxPath, branch: ws.branch, profile, createdAt: state.createdAt, base: ws.base, ...extra }
  } catch (error) {
    await abandon(ctx, box, ws, sessionID, correlationId)
    throw error
  }
}

export const startSessionTool = defineTool({
  name: "oc_start_session",
  title: "Start a delegated OpenCode session",
  description:
    "Start an OpenCode session on a copy of a git repository. The session starts from your current branch: that branch (HEAD) is bundled into the sandbox, where the agent works on branch delegate/<key>. The owner's repo is never mounted or changed until oc_collect fetches that branch back. " +
    "By default it refuses while another session of this bridge is still working in the same repo; that check is advisory (each session has its own copy), so allowShared: true runs both.",
  input: {
    directory: z.string().min(1).max(1024).describe("The owner's repository (a folder under the allowed roots, e.g. C:\\GitHub\\my-repo)."),
    title: z.string().max(200).optional(),
    agent: agentSchema.optional().describe("OpenCode agent for the session, e.g. build (default) or plan."),
    model: modelSchema.optional().describe("Default model for this session's sends: a Synapse model from oc_list_models (synapse/<id>). Default: the sandbox's default, synapse/auto. Ignored when taskRole resolves a model (model wins if both)."),
    taskRole: z.string().min(1).max(64).optional().describe("D4: what this session is for (e.g. code, qa, architecture). The bridge sets the session's default model to Synapse's best-fit for that role from live benchmark data (see oc_list_models `roles`); falls back to the normal default when there is no fit data yet."),
    profile: z.enum(["standard", "readonly"]).optional().describe("Permission profile. readonly denies edits and asks before any shell command and Keystone tool call (except the dynamic connection when the delegation gate asks before risky tools). Default standard."),
    allowShared: z.boolean().optional().describe("Allow this session while another one of ours is still working in the same repo (each has its own copy)."),
    keystone: z
      .array(z.string().regex(CONNECTION_ID, "a Keystone connection id"))
      .max(MAX_CONNECTIONS)
      .optional()
      .describe("Only these Keystone connections' tools for this session (a subset of the sandbox's set; see oc_list_models). A convenience, not a security boundary. Default: all of the sandbox's set."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const hostRepo = await ctx.workspaces.resolveRepo(args.directory)
    const keystone = sessionKeystone(ctx, args.keystone)
    if (!args.allowShared) await refuseBusy(ctx, hostRepo, samePath)
    const box = await ctx.box()
    if (args.model) await requireModel(box.api, args.model, correlationId, ctx)
    // D4: with no explicit model, a task role sets the session's default to Synapse's best-fit
    // from live benchmark data. No data / unknown role / unreadable: the normal default stands and
    // the result says why (a hint never blocks a start, never guesses a model).
    let model = args.model
    let taskPick: { role: string; model: string; score: number } | { role: string; fellBack: string } | undefined
    if (!model && args.taskRole) {
      const offered = await fetchModels(box.api, correlationId)
      const pick = await pickRoleModel(ctx, args.taskRole, offered)
      if ("model" in pick) {
        model = pick.model
        taskPick = { role: args.taskRole, model: pick.model, score: pick.score }
      } else {
        taskPick = { role: args.taskRole, fellBack: pick.none }
      }
    }
    const ws = await ctx.workspaces.open(hostRepo, newSessionKey())
    const record = await startIn(ctx, box, { ...args, model, keystone }, ws, correlationId)
    ctx.sessions.set(record.sessionID, record)
    box.hub.track(record.sessionID, ws.boxPath)
    recordStart(ctx, record)
    return ok(`Session ${record.sessionID} started on ${ws.branch}. Next: oc_send, then oc_wait.${taskPick && "model" in taskPick ? ` Model for role "${taskPick.role}": ${taskPick.model} (Synapse fit ${taskPick.score.toFixed(2)}).` : ""}`, {
      sessionID: record.sessionID, sessionKey: ws.sessionKey, branch: ws.branch, boxPath: ws.boxPath, hostRepo: ws.hostRepo, profile: record.profile, base: ws.base,
      ...(keystone ? { keystone } : {}),
      ...(taskPick ? { taskPick } : {}),
      webUrl: webUrl(box.target, ws.boxPath, record.sessionID),
    })
  },
})

export const abortTool = defineTool({
  name: "oc_abort",
  title: "Stop a session's run",
  description: "Ask the sandbox to abort the current run of one of this bridge's sessions. The workspace and history are kept. Check the result with oc_status.",
  input: {
    sessionID: sessionIdSchema,
    force: z.boolean().optional().describe("Abort even if owned by another caller. Default false."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const box = await ctx.box()
    const { record } = await ownSession(ctx, box, args.sessionID, correlationId)
    if (record.caller && ctx.caller && record.caller !== ctx.caller && !args.force) {
      throw new DelegateError(
        "policy_violation",
        `Session ${record.sessionID} belongs to caller "${record.caller}", not "${ctx.caller}".`,
        "Pass force: true to abort another caller's session.",
        `owned by ${record.caller}`,
      )
    }
    const res = await box.api.call<unknown>({ method: "POST", path: `/session/${record.sessionID}/abort`, directory: record.boxPath, correlationId })
    if (res.status === 404) throw new DelegateError("not_found", `Session ${record.sessionID} is gone: the sandbox no longer has it.`, "Start a new session with oc_start_session.", "HTTP 404")
    if (res.status < 200 || res.status >= 300) throw new DelegateError("upstream_error", "The delegate server failed to abort the session.", "Retry; check oc_status.", `HTTP ${res.status}`)
    const accepted = res.data === true
    const summary = accepted ? `Abort requested for ${record.sessionID}. Check oc_status for the result.` : `Abort requested for ${record.sessionID}, but the server did not confirm it (nothing may have been running). Check oc_status.`
    return ok(summary, { sessionID: record.sessionID, abortRequested: true, serverConfirmed: accepted })
  },
})
