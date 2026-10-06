// MOD-04 core helpers: session ids, keys, models and cursors, and "is this session ours?".
// A session is ours when this bridge started it (ctx.sessions) or when the bridge's HOST record
// (<home>/workspaces/<key>.json, never mounted in the box) names it: same sessionID, same
// supervisor address (review W3C-01 / W3A-01). The box's session metadata is only used to find
// that record (metadata.sessionKey); everything in the adopted record (repo, base, profile, model,
// agent) comes from the host record, so a session forged in the box cannot claim another repo or
// upgrade a readonly profile.
import { randomBytes } from "node:crypto"
import { z } from "zod"
import type { Cursor } from "../shared/contracts.ts"
import { DelegateError } from "../shared/errors.ts"
import type { ApiTarget } from "../shared/opencode-api.ts"
import { AGENT_RE, MODEL_RE, SESSION_ID_RE, SESSION_KEY, type HostSessionState, type SessionProfile } from "../supervisor/workspaces-state.ts"
import type { Box, SessionRecord, ToolContext } from "./context.ts"
import { closingError, isClosing } from "./closing.ts"

export { AGENT_RE, MODEL_RE, SESSION_ID_RE, type SessionProfile }
export const CORRELATION_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const CURSOR_RE = /^([A-Za-z0-9-]{1,64})\.(\d{1,15})$/

export const sessionIdSchema = z.string().regex(SESSION_ID_RE, "a session id such as ses_0123456789abcdef")
export const modelSchema = z.string().regex(MODEL_RE, "provider/model, for example synapse/auto")
export const agentSchema = z.string().regex(AGENT_RE, "an agent name such as build or plan")
export const cursorSchema = z.string().regex(CURSOR_RE, "a cursor returned by oc_send, oc_wait or oc_events")

/** Session metadata the bridge writes on POST /session: a lookup key for the host record, nothing more. */
export type SessionMetadata = { supervisor: string; sessionKey: string }

/** The subset of the server's Session.Info the bridge reads. All of it is box data. */
export type RemoteSession = {
  id: string
  directory?: string
  title?: string
  parentID?: string
  metadata?: Record<string, unknown>
  permission?: Array<{ permission: string; pattern: string; action: string }>
  time?: { created?: number; updated?: number }
}

export function newSessionKey(): string {
  return `s-${randomBytes(5).toString("hex")}`
}

export const boxPathOf = (key: string) => `/sessions/${key}`

export function parseModel(value: string): { providerID: string; modelID: string } {
  if (!MODEL_RE.test(value)) throw new DelegateError("invalid_input", "The model must look like provider/model.", "Pick one from oc_list_models, for example synapse/auto.")
  const slash = value.indexOf("/")
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

/**
 * #71: Synapse is the box's only provider (enabled_providers: ["synapse"]), so a model of any other
 * provider is refused with a clear error rather than failing inside the box.
 */
export function requireSynapseModel(model: string): void {
  if (parseModel(model).providerID === "synapse") return
  throw new DelegateError("invalid_input", "The sandbox offers only Synapse models (synapse/<id>).", "Call oc_list_models and pick one of its ids, for example synapse/auto (the default).")
}

export function formatCursor(cursor: Cursor): string {
  return `${cursor.epoch}.${cursor.seq}`
}

export function parseCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined
  const m = CURSOR_RE.exec(value)
  if (!m?.[1] || !m[2]) throw new DelegateError("invalid_input", "The cursor is not one the bridge issued.", "Pass a cursor from oc_send, oc_wait or oc_events, or leave it out.")
  return { epoch: m[1], seq: Number(m[2]) }
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

/** The web UI link for a session. Built from the base URL only: never carries the password (L6). */
export function webUrl(target: ApiTarget, directory: string, sessionID: string): string {
  const base = new URL(target.baseUrl)
  return `${base.protocol}//${base.host}/${base64Url(directory)}/session/${sessionID}`
}

export function checkSessionId(sessionID: string): void {
  if (!SESSION_ID_RE.test(sessionID)) throw new DelegateError("invalid_input", "That is not a session id.", "Pass a sessionID returned by oc_start_session or oc_list_sessions.")
}

function notOurs(sessionID: string, why: string, parentID?: unknown): DelegateError {
  const parent = typeof parentID === "string" && SESSION_ID_RE.test(parentID) ? parentID : undefined
  const action = parent
    ? `This is a subagent session: use its parent session ${parent} instead (oc_pending also lists a subagent's requests under its parent).`
    : "Use oc_list_sessions to see this bridge's sessions, or start one with oc_start_session."
  return new DelegateError("not_found", `Session ${sessionID} is not one of this bridge's sessions.`, action, why)
}

/** W3A-17: one of OUR sessions that the server no longer has. */
export function sessionGone(sessionID: string): DelegateError {
  return new DelegateError("not_found", `Session ${sessionID} is gone: the sandbox no longer has it (it was deleted, or the sandbox was reset).`, "Start a new session with oc_start_session; collect its branch first with oc_collect if the clone is still there.", "HTTP 404")
}

export async function readSession(ctx: ToolContext, box: Box, sessionID: string, correlationId: string, directory?: string, ours = false): Promise<RemoteSession> {
  checkSessionId(sessionID)
  const res = await box.api.call<RemoteSession>({ path: `/session/${sessionID}`, directory, correlationId })
  if (res.status === 404) throw ours ? sessionGone(sessionID) : notOurs(sessionID, "HTTP 404")
  if (res.status < 200 || res.status >= 300 || !res.data || res.data.id !== sessionID)
    throw new DelegateError("upstream_error", "The delegate server failed to read the session.", "Retry; if it repeats, run oc_doctor.", `HTTP ${res.status}`)
  ctx.log.log("debug", "tools", "session read", { sessionID, correlationId })
  return res.data
}

/** The host record for a key, or undefined (a damaged or unreadable record is never trusted). */
export async function hostState(ctx: ToolContext, key: string): Promise<HostSessionState | undefined> {
  if (!SESSION_KEY.test(key)) return undefined
  try {
    return await ctx.workspaces.sessionState(key)
  } catch (error) {
    ctx.log.log("warn", "tools", "host session record unreadable", { sessionKey: key, detail: error instanceof DelegateError ? error.detail ?? error.code : "unknown" })
    return undefined
  }
}

/** Host records that name a session of THIS bridge. */
export async function ownedStates(ctx: ToolContext): Promise<Array<HostSessionState & { sessionID: string }>> {
  const states: HostSessionState[] = await ctx.workspaces.listSessionStates().catch(() => [])
  return states.filter((s): s is HostSessionState & { sessionID: string } => s.sessionID !== undefined && s.supervisor === ctx.supervisor)
}

/** A SessionRecord built only from the host record (the repo is re-checked against the roots). */
export async function recordFromState(ctx: ToolContext, state: HostSessionState & { sessionID: string }): Promise<SessionRecord> {
  return {
    sessionID: state.sessionID,
    sessionKey: state.sessionKey,
    hostRepo: await ctx.workspaces.resolveRepo(state.hostRepo),
    boxPath: boxPathOf(state.sessionKey),
    branch: `delegate/${state.sessionKey}`,
    profile: state.profile ?? "standard",
    createdAt: state.createdAt,
    base: state.base,
    ...(state.model ? { model: state.model } : {}),
    ...(state.agent ? { agent: state.agent } : {}),
    ...(state.keystone ? { keystone: state.keystone } : {}),
    ...(state.caller ? { caller: state.caller } : {}),
  }
}

/** Adopt a session the box has: only when the host record for its key names this id and this bridge. */
async function adopt(ctx: ToolContext, remote: RemoteSession): Promise<SessionRecord> {
  const key = typeof remote.metadata?.sessionKey === "string" ? remote.metadata.sessionKey : ""
  const state = await hostState(ctx, key)
  if (!state || state.sessionID !== remote.id || state.supervisor !== ctx.supervisor) throw notOurs(remote.id, "no host record of this bridge names it", remote.parentID)
  if (remote.directory !== boxPathOf(state.sessionKey)) throw notOurs(remote.id, "directory does not match its host record")
  return recordFromState(ctx, { ...state, sessionID: state.sessionID })
}

export type OwnedSession = { record: SessionRecord; remote?: RemoteSession }

/**
 * The record for one of our sessions. Known sessions are returned as they are (with the remote
 * read when `read` is set); unknown ones are adopted only through the host record (see adopt).
 */
export async function ownSession(ctx: ToolContext, box: Box, sessionID: string, correlationId: string, read = false): Promise<OwnedSession> {
  checkSessionId(sessionID)
  // #72: a session being closed is not handed to send, collect or any other tool meanwhile.
  if (isClosing(ctx, sessionID)) throw closingError(sessionID)
  const known = ctx.sessions.get(sessionID)
  if (known && !read) return { record: known }
  const remote = await readSession(ctx, box, sessionID, correlationId, known?.boxPath, known !== undefined)
  if (known) return { record: known, remote }
  const record = await adopt(ctx, remote)
  ctx.sessions.set(sessionID, record)
  box.hub.track(sessionID, record.boxPath)
  ctx.log.log("info", "tools", "adopted session from its host record", { sessionID, sessionKey: record.sessionKey, correlationId })
  return { record, remote }
}

/** Shape a session's permission rules for comparison (the server may add fields). */
export function sameRules(actual: RemoteSession["permission"], expected: Array<{ permission: string; pattern: string; action: string }>): boolean {
  if (!actual || actual.length !== expected.length) return false
  return actual.every((rule, i) => rule.permission === expected[i]?.permission && rule.pattern === expected[i]?.pattern && rule.action === expected[i]?.action)
}
