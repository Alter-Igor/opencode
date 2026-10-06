// MOD-03: SessionView construction for EventHub.view(). A tracked state the hub is sure of is
// answered locally; everything else is read from the server, and a failed read says so
// (unknown, or server_down only when the server really did not accept the connection).
import { BOX_DIRECTORY_RE, type SessionState, type SessionView } from "../shared/contracts.ts"
import { isDelegateError } from "../shared/errors.ts"
import type { Remote } from "./server.ts"
import type { EntryView } from "./state.ts"

/** States the hub observed itself; anything else (unresolved, unknown, server_down) is re-read. */
export const TRUSTED = new Set<string>(["starting", "busy", "retry", "needs_input", "idle", "error", "aborted", "not_started", "not_found"])

const iso = (ms: number) => new Date(ms).toISOString()

const wellFormed = (d: string | undefined): d is string => d !== undefined && BOX_DIRECTORY_RE.test(d)

type Placement = Pick<SessionView, "directory" | "directoryMismatch" | "reportedDirectory">

/**
 * Where a view says the session lives (R3-03). The box's answer is box-written text (in-box code
 * can rewrite the session row), so it never replaces the tracked path: a differing answer only sets
 * directoryMismatch, and is shown as reportedDirectory when it is a well-formed box path (dropped
 * otherwise). Without a tracked path, only a well-formed answer is used.
 */
export function placement(tracked: string | undefined, reported: string | undefined): Placement {
  if (!tracked) return { directory: wellFormed(reported) ? reported : "" }
  const out: Placement = { directory: wellFormed(tracked) ? tracked : "" }
  if (reported === undefined || reported === tracked) return out
  out.directoryMismatch = true
  if (wellFormed(reported)) out.reportedDirectory = reported
  return out
}

export function entryView(e: EntryView): SessionView {
  const view: SessionView = { sessionID: e.sessionID, ...placement(e.directory, e.reportedDirectory), state: e.state === "unresolved" ? "unknown" : e.state, since: iso(e.since) }
  if (e.detail) view.detail = e.detail
  if (e.pending.length) view.pending = e.pending
  if (e.parentID) view.parentID = e.parentID
  if (e.lastError) {
    view.lastError = e.lastError
    view.errorCode = e.errorCode ?? e.lastError
  }
  if (e.lastActiveAt) view.lastActiveAt = iso(e.lastActiveAt)
  return view
}

/** A server read: `since` is the read time, so it is also given as `observedAt` (W2A-16). */
export function remoteView(sessionID: string, remote: Remote, now: number, detail: string, known?: EntryView): SessionView {
  const { entry } = remote
  const waiting = entry.pending.length > 0 && entry.base !== "not_found"
  const observedAt = iso(now)
  const view: SessionView = { sessionID, ...placement(known?.directory, remote.directory), state: waiting ? "needs_input" : entry.base, since: observedAt, observedAt, detail: entry.detail ? `${entry.detail}; ${detail}` : detail }
  if (waiting) view.pending = entry.pending.map((p) => p.requestID)
  if (known?.parentID) view.parentID = known.parentID
  if (known?.lastError) {
    view.lastError = known.lastError
    view.errorCode = known.errorCode ?? known.lastError
  }
  if (known?.lastActiveAt) view.lastActiveAt = iso(known.lastActiveAt)
  return view
}

/**
 * The server read failed. Only a refused connection is server_down; a timeout is unknown (the
 * server may be up but slow), and the error's own detail is kept (W2A-15).
 */
export function failedView(sessionID: string, directory: string, error: unknown, now: number): SessionView {
  const code = isDelegateError(error) ? error.code : "upstream_error"
  const detail = (isDelegateError(error) ? error.detail : undefined) ?? code
  const state: SessionState = code === "server_down" && detail !== "timeout" ? "server_down" : "unknown"
  const observedAt = iso(now)
  return { sessionID, ...placement(directory, undefined), state, since: observedAt, observedAt, detail }
}
