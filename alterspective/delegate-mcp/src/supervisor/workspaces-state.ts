// MOD-01 host-only session records (review W3C-01 / W3A-01): <home>/workspaces/<key>.json.
// The folder is never mounted in the box, so this is the bridge's own record of a session: which
// repository and base commit its clone came from, which OpenCode session id it became, which
// bridge (supervisor address) owns it and with which profile, model and agent. Adoption after a
// bridge restart, "is this mine?" and the instruction source all come from here; the box's session
// metadata is only a lookup key. Files are written whole (temp file + rename) and validated on read.
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { PROJECT_RE } from "../shared/config.ts"
import { SESSION_ID_RE } from "../shared/contracts.ts"
import { DelegateError } from "../shared/errors.ts"
import { CONNECTION_ID, MAX_CONNECTIONS } from "../shared/keystone.ts"

export { SESSION_ID_RE }

export const SESSION_KEY = /^[a-z0-9-]{4,64}$/
/** A full commit id: SHA-1 (40 hex) or, for sha256 repositories, 64 hex. */
export const COMMIT_ID = /^([0-9a-f]{40}|[0-9a-f]{64})$/
/** `provider/model`; the model part may itself contain `/` (e.g. openrouter ids). */
export const MODEL_RE = /^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._:/@-]{1,128}$/
export const AGENT_RE = /^[A-Za-z0-9._-]{1,64}$/
export const SUPERVISOR_RE = /^supervisor:[a-z0-9-]{1,40}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
/** Newest records read by listHostStates (a fixed bridge name can collect many over time). */
export const MAX_LISTED_STATES = 200

export type SessionProfile = "standard" | "readonly"

/** What the bridge knows about a session workspace. `sessionID` and the rest are set once the session exists. */
export type HostSessionState = {
  sessionKey: string
  hostRepo: string
  base: string
  createdAt: string
  sessionID?: string
  profile?: SessionProfile
  supervisor?: string
  model?: string
  agent?: string
  /** R4-01: the Keystone connections the session was narrowed to; absent = the whole box-wide set. */
  keystone?: string[]
  /** #146: which caller started the session (callerName); for filtering and caller isolation. */
  caller?: string
  /**
   * #53: the compose project (OPENCODE_DELEGATE_PROJECT) of the box whose `sessions` volume holds the
   * clone, stamped at bind time. Absent on records from older bridges; those are never pruned.
   */
  boxProject?: string
}

/** Written by oc_start_session right after POST /session; the workspaces layer adds `boxProject`. */
export type SessionBinding = { sessionID: string; profile: SessionProfile; supervisor: string; model?: string; agent?: string; keystone?: string[]; boxProject?: string; caller?: string }

/** A valid narrowing list (each a connection id, bounded), or undefined. */
function keystoneList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CONNECTIONS) return undefined
  return value.every((id) => typeof id === "string" && CONNECTION_ID.test(id)) ? (value as string[]) : undefined
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown"
const statePath = (dir: string, key: string) => path.join(dir, `${key}.json`)
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

function optional(value: unknown, re: RegExp): string | undefined {
  const s = str(value)
  return s !== undefined && re.test(s) ? s : undefined
}

/** Parse and validate a record; undefined when anything required is missing or malformed. */
export function parseHostState(raw: string, key: string): HostSessionState | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const p = parsed as Record<string, unknown>
  const hostRepo = str(p.hostRepo)
  const base = optional(p.base, COMMIT_ID)
  if (!hostRepo || !base) return undefined
  const createdAt = optional(p.createdAt, ISO_RE) ?? new Date(0).toISOString()
  const state: HostSessionState = { sessionKey: key, hostRepo, base, createdAt }
  const sessionID = optional(p.sessionID, SESSION_ID_RE)
  const supervisor = optional(p.supervisor, SUPERVISOR_RE)
  if (sessionID && supervisor) Object.assign(state, { sessionID, supervisor, profile: p.profile === "readonly" ? "readonly" : "standard" })
  const model = optional(p.model, MODEL_RE)
  const agent = optional(p.agent, AGENT_RE)
  // A narrowing list that does not parse is dropped; the session's permission rules then no longer
  // match on the next send (send.ts), which refuses it: fails closed.
  const keystone = keystoneList(p.keystone)
  // A box name that does not parse is dropped: the record then counts as legacy and is never pruned.
  const boxProject = optional(p.boxProject, PROJECT_RE)
  const caller = str(p.caller)?.slice(0, 128)
  return { ...state, ...(model ? { model } : {}), ...(agent ? { agent } : {}), ...(keystone ? { keystone } : {}), ...(boxProject ? { boxProject } : {}), ...(caller ? { caller } : {}) }
}

function checkState(state: HostSessionState): void {
  const bad =
    !SESSION_KEY.test(state.sessionKey) ||
    !COMMIT_ID.test(state.base) ||
    (state.sessionID !== undefined && !SESSION_ID_RE.test(state.sessionID)) ||
    (state.supervisor !== undefined && !SUPERVISOR_RE.test(state.supervisor)) ||
    (state.model !== undefined && !MODEL_RE.test(state.model)) ||
    (state.agent !== undefined && !AGENT_RE.test(state.agent)) ||
    (state.keystone !== undefined && keystoneList(state.keystone) === undefined) ||
    (state.boxProject !== undefined && !PROJECT_RE.test(state.boxProject)) ||
    (state.caller !== undefined && typeof state.caller !== "string")
  if (bad) throw new DelegateError("upstream_error", "The session's host record would not be valid, so it was not saved.", "Start the session again with oc_start_session.", "invalid host state")
}

/** Write the whole record (temp file, then rename over the old one). */
export function writeHostState(dir: string, state: HostSessionState): void {
  checkState(state)
  const file = statePath(dir, state.sessionKey)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, file)
  } catch (error) {
    // A-07: the host path and errno go to detail only.
    throw new DelegateError("upstream_error", "The bridge could not save this session's workspace record on the host.", "Check the bridge home folder (OPENCODE_DELEGATE_HOME) is writable, then start the session again.", `${errno(error)} ${file}`)
  }
}

/** The record for `key`: undefined when there is none; throws when it cannot be read or is damaged. */
export function readHostState(dir: string, key: string): HostSessionState | undefined {
  if (!SESSION_KEY.test(key)) return undefined
  const file = statePath(dir, key)
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined
    throw new DelegateError("upstream_error", "The bridge could not read this session's workspace record on the host.", "Check the bridge home folder (OPENCODE_DELEGATE_HOME) is readable, then retry.", `${errno(error)} ${file}`)
  }
  const state = parseHostState(raw, key)
  if (state) return state
  throw new DelegateError(
    "not_found",
    "This session's workspace record on the host is damaged.",
    `Delete ${key}.json from the bridge's workspaces folder (the bridge log has the full path), then start a new session with oc_start_session.`,
    `corrupt: ${file}`,
  )
}

/** Every readable record (damaged ones are skipped), newest first, at most MAX_LISTED_STATES. */
export function listHostStates(dir: string): HostSessionState[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"))
  } catch (error) {
    if (errno(error) === "ENOENT") return []
    throw new DelegateError("upstream_error", "The bridge could not list its session records on the host.", "Check the bridge home folder (OPENCODE_DELEGATE_HOME) is readable, then retry.", `${errno(error)} ${dir}`)
  }
  const states: HostSessionState[] = []
  for (const name of names) {
    try {
      const state = readHostState(dir, name.slice(0, -".json".length))
      if (state) states.push(state)
    } catch {
      // damaged or unreadable: not listed (readHostState reports it when the key is asked for)
    }
  }
  return states.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_LISTED_STATES)
}

/** Record the OpenCode session a workspace became. Refused when the record already names another session. */
export function bindHostState(dir: string, key: string, binding: SessionBinding): HostSessionState {
  const current = readHostState(dir, key)
  if (!current) throw new DelegateError("not_found", "This session has no workspace record on the host.", "Start a new session with oc_start_session.", `missing: ${key}`)
  if (current.sessionID && current.sessionID !== binding.sessionID)
    throw new DelegateError("directory_busy", "This workspace already belongs to another session.", "Start a new session with oc_start_session.", `bound: ${key}`)
  const next: HostSessionState = { ...current, ...binding }
  writeHostState(dir, next)
  return next
}

/** Best effort: remove the record for `key`. Never throws. */
export function removeHostState(dir: string, key: string): void {
  if (!SESSION_KEY.test(key)) return
  try {
    unlinkSync(statePath(dir, key))
  } catch {
    // already gone, or left for the owner (the log has the path)
  }
}
