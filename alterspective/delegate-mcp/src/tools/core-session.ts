// MOD-04 core helpers: session ids, keys, models and cursors, and "is this session ours?".
// A session is ours when this bridge started it (ctx.sessions) or when the box says its
// metadata.supervisor is this bridge's address (adopted after a bridge restart with the same
// OPENCODE_DELEGATE_NAME). Everything read from the box is untrusted, so adopted metadata is
// validated as strictly as tool input (repo under the roots, key and base shapes).
import { randomBytes } from "node:crypto"
import { z } from "zod"
import type { Cursor } from "../shared/contracts.ts"
import { DelegateError } from "../shared/errors.ts"
import type { ApiTarget } from "../shared/opencode-api.ts"
import { COMMIT_ID, SESSION_KEY } from "../supervisor/workspaces.ts"
import type { Box, SessionRecord, ToolContext } from "./context.ts"

/** OpenCode session ids (id/id.ts). */
export const SESSION_ID_RE = /^ses_[A-Za-z0-9]{8,64}$/
/** `provider/model`; the model part may itself contain `/` (e.g. openrouter ids). */
export const MODEL_RE = /^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._:/@-]{1,128}$/
export const AGENT_RE = /^[A-Za-z0-9._-]{1,64}$/
export const CORRELATION_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const CURSOR_RE = /^([A-Za-z0-9-]{1,64})\.(\d{1,15})$/

export const sessionIdSchema = z.string().regex(SESSION_ID_RE, "a session id such as ses_0123456789abcdef")
export const modelSchema = z.string().regex(MODEL_RE, "provider/model, for example synapse/auto")
export const agentSchema = z.string().regex(AGENT_RE, "an agent name such as build or plan")
export const cursorSchema = z.string().regex(CURSOR_RE, "a cursor returned by oc_send, oc_wait or oc_events")

export type SessionProfile = SessionRecord["profile"]

/** Session metadata keys the bridge writes on POST /session (`supervisor` is SESSION_SUPERVISOR_KEY). */
export type SessionMetadata = { supervisor: string; sessionKey: string; hostRepo: string; base?: string; profile: SessionProfile; model?: string; agent?: string }

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

export function parseModel(value: string): { providerID: string; modelID: string } {
  if (!MODEL_RE.test(value)) throw new DelegateError("invalid_input", "The model must look like provider/model.", "Pick one from oc_list_models, for example synapse/auto.")
  const slash = value.indexOf("/")
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
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

function notOurs(sessionID: string, why: string): DelegateError {
  return new DelegateError("not_found", `Session ${sessionID} is not one of this bridge's sessions.`, "Use oc_list_sessions to see this bridge's sessions, or start one with oc_start_session.", why)
}

export async function readSession(ctx: ToolContext, box: Box, sessionID: string, correlationId: string, directory?: string): Promise<RemoteSession> {
  checkSessionId(sessionID)
  const res = await box.api.call<RemoteSession>({ path: `/session/${sessionID}`, directory, correlationId })
  if (res.status === 404) throw notOurs(sessionID, "HTTP 404")
  if (res.status < 200 || res.status >= 300 || !res.data || res.data.id !== sessionID)
    throw new DelegateError("upstream_error", "The delegate server failed to read the session.", "Retry; if it repeats, run oc_doctor.", `HTTP ${res.status}`)
  ctx.log.log("debug", "tools", "session read", { sessionID, correlationId })
  return res.data
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

/** Rebuild a SessionRecord from the box's metadata, validating every field (it is box data). */
async function adopt(ctx: ToolContext, remote: RemoteSession): Promise<SessionRecord> {
  const meta = remote.metadata ?? {}
  const key = text(meta.sessionKey)
  const hostRepo = text(meta.hostRepo)
  const base = text(meta.base)
  if (!key || !SESSION_KEY.test(key) || !hostRepo) throw notOurs(remote.id, "metadata incomplete")
  const boxPath = `/sessions/${key}`
  if (remote.directory !== boxPath) throw notOurs(remote.id, "directory does not match its session key")
  const repo = await ctx.workspaces.resolveRepo(hostRepo)
  const model = text(meta.model)
  const agent = text(meta.agent)
  return {
    sessionID: remote.id,
    sessionKey: key,
    hostRepo: repo,
    boxPath,
    branch: `delegate/${key}`,
    profile: meta.profile === "readonly" ? "readonly" : "standard",
    createdAt: new Date(remote.time?.created ?? Date.now()).toISOString(),
    base: base && COMMIT_ID.test(base) ? base : undefined,
    ...(model && MODEL_RE.test(model) ? { model } : {}),
    ...(agent && AGENT_RE.test(agent) ? { agent } : {}),
  }
}

export type OwnedSession = { record: SessionRecord; remote?: RemoteSession }

/**
 * The record for one of our sessions. Known sessions are returned as they are (with the remote
 * read when `read` is set); unknown ones are adopted only when metadata.supervisor is ours.
 */
export async function ownSession(ctx: ToolContext, box: Box, sessionID: string, correlationId: string, read = false): Promise<OwnedSession> {
  checkSessionId(sessionID)
  const known = ctx.sessions.get(sessionID)
  if (known && !read) return { record: known }
  const remote = await readSession(ctx, box, sessionID, correlationId, known?.boxPath)
  if (known) return { record: known, remote }
  if (remote.metadata?.supervisor !== ctx.supervisor) throw notOurs(sessionID, "metadata.supervisor is another bridge's")
  const record = await adopt(ctx, remote)
  ctx.sessions.set(sessionID, record)
  box.hub.track(sessionID, record.boxPath)
  ctx.log.log("info", "tools", "adopted session from its metadata", { sessionID, sessionKey: record.sessionKey, correlationId })
  return { record, remote }
}

/** Shape a session's permission rules for comparison (the server may add fields). */
export function sameRules(actual: RemoteSession["permission"], expected: Array<{ permission: string; pattern: string; action: string }>): boolean {
  if (!actual || actual.length !== expected.length) return false
  return actual.every((rule, i) => rule.permission === expected[i]?.permission && rule.pattern === expected[i]?.pattern && rule.action === expected[i]?.action)
}
