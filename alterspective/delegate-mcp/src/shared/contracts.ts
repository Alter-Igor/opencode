// Interfaces the modules implement and the tool surface (MOD-04) consumes.
// Owned by the capability hub; modules must not change these without the hub.
import type { ApiTarget, OpencodeApi } from "./opencode-api.ts"

/** OpenCode session ids (id/id.ts). The one session-id shape the bridge accepts (W3A-19). */
export const SESSION_ID_RE = /^ses_[A-Za-z0-9]{8,64}$/
/** A box folder the bridge makes (`/sessions/<key>`). Any other directory the box reports is box text (R3-03). */
export const BOX_DIRECTORY_RE = /^\/sessions\/[a-z0-9-]{1,64}$/

/** MOD-01: one Docker box per user. */
export type BoxState =
  | { state: "running"; target: ApiTarget; imageTag: string; startedBy: "this-bridge" | "other" }
  | { state: "stopped" }
  | { state: "unavailable"; reason: string }

export interface Supervisor {
  /** Start the box if needed (building the image/profile first) and return how to reach it. */
  ensure(): Promise<ApiTarget>
  status(): Promise<BoxState>
  /** Stop the box only when this bridge holds the last lease. */
  release(): Promise<void>
  /** Keystone sign-in for one ks-* entry: opens the owner's browser and relays the code. */
  login(entry: string, opener?: (url: string) => void): Promise<"connected" | "failed">
}

/** MOD-01: session workspaces moved by git bundles (technical-design §4). */
export type Workspace = { sessionKey: string; hostRepo: string; boxPath: string; branch: string }

export interface Workspaces {
  /** Bundle the owner's repo, clone it in the box, create branch `delegate/<key>`. */
  open(hostRepo: string, sessionKey: string): Promise<Workspace>
  /** Bundle the session branch in the box and fetch it into the owner's repo. Returns the branch name. */
  collect(workspace: Workspace): Promise<{ branch: string; commits: number; hostExecutableChanges: string[] }>
}

/** MOD-02: policy verdicts. Every check fails closed. */
export type Verdict = { ok: true } | { ok: false; code: "policy_violation" | "policy_unverified"; reason: string }

export type McpEntry = { type?: string; url?: string; headers?: Record<string, string>; oauth?: unknown; enabled?: boolean; timeout?: number }

export interface Guard {
  /** Profile-time validation of MCP entries (ks-<id> → /mcp/c/<id>, id in the chosen Keystone set). */
  validateEntries(entries: Record<string, McpEntry>): Verdict
  /** Runtime check before each send: GET /mcp for the session directory (only chosen ks-<id> entries). */
  checkRuntime(api: OpencodeApi, directory: string): Promise<Verdict>
  /**
   * Permission ruleset applied on POST /session and in the profile. Additive: `keystone` narrows a
   * session's Keystone tools to those connection ids (convenience, not a wall).
   */
  permissionBaseline(profile: "standard" | "readonly", keystone?: readonly string[]): Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
  /** Refuse `always` replies (FM-4). */
  checkPermissionReply(reply: string): Verdict
}

/** MOD-03: session states (technical-design §6). Absent data is a state, never a guess. */
export type SessionState =
  | "starting"
  | "busy"
  | "retry"
  | "needs_input"
  | "idle"
  | "error"
  | "aborted"
  | "not_started"
  | "unknown"
  | "not_found"
  | "server_down"

export type Cursor = { epoch: string; seq: number }

/** `link` (additive, Wave 2 fix W2A-11): the hub's event stream went up, dropped or the box went away; no sessionID, no state. */
export type HubEventType = "status" | "permission" | "question" | "message" | "error" | "todo" | "resync" | "mcp" | "inbox" | "link"

export type HubEvent = {
  cursor: Cursor
  at: string
  type: HubEventType
  sessionID?: string
  /** Additive: set when `sessionID` is a subagent (child) session of a tracked session. */
  parentID?: string
  directory?: string
  state?: SessionState
  /**
   * One line for a person or an AI, built only from bridge words, counts, states and ids that
   * match [A-Za-z0-9_.:-]{1,40}. Box-supplied names (tools, errors, MCP servers) and
   * session-originated text are never put here (see `untrusted`).
   */
  summary: string
  /** Text or names that came from a session or the box; always treated as untrusted by consumers. */
  untrusted?: string
  /** Request id for permission/question events (answer with oc_answer). Always matches ^(per|que)_[A-Za-z0-9]{1,36}$. */
  requestID?: string
  /** Additive (#80): for error events, why the session failed, from the bridge's known set (session-error.ts), else "other". */
  code?: string
}

/**
 * `since`: when the hub saw this state begin. When `observedAt` is set (additive) the view was
 * read from the server at that moment instead: the state began at or before `since` (= observedAt).
 * `pending` of a parent includes the request ids of its subagents. `lastError` (additive) is the
 * last error the session reported, as a known error name or "unrecognised error".
 * `directory` is the path the bridge tracked, never the box's answer (R3-03). `directoryMismatch`
 * (additive) says the box reports the session elsewhere; `reportedDirectory` is that answer, shown
 * only when it is a well-formed box path.
 */
export type SessionView = {
  sessionID: string
  directory: string
  directoryMismatch?: true
  reportedDirectory?: string
  state: SessionState
  since: string
  detail?: string
  pending?: string[]
  observedAt?: string
  parentID?: string
  lastError?: string
  /** #139: normalized error code for failed sessions (budget_exhausted, skipped_breaker, rate_limited, etc.). */
  errorCode?: string
  /** #141: ISO timestamp of last seen model or tool activity. */
  lastActiveAt?: string
}

export type WaitUntil = "idle" | "needs_input" | "error" | "message"

export interface EventHub {
  start(): Promise<void>
  stop(): Promise<void>
  /** Start tracking a session the bridge created or adopted. Its subagent sessions are tracked automatically. */
  track(sessionID: string, directory: string): void
  /**
   * Call right after prompt_async: arms the 10 s not_started watchdog (one per session; a new
   * send replaces it). oc_send must read `cursor()` BEFORE prompt_async and hand that cursor to
   * oc_wait, so events that beat the 204 are not missed.
   */
  markSent(sessionID: string): void
  /** Additive: the current head cursor (events after it are the ones not seen yet). */
  cursor(): Cursor
  /** Current state; resolves absent data by reading the server (idle vs not_found). */
  view(sessionID: string): Promise<SessionView>
  /** Page of buffered events after `cursor`. A cursor from another epoch → expired:true. */
  events(cursor: Cursor | undefined, filter?: { sessionID?: string }, limit?: number): { events: HubEvent[]; next: Cursor; expired: boolean }
  /**
   * Long-poll until a matching event, or timeout (caller caps at 240 s). `until: idle` means
   * settled (idle, error, aborted, not_started or not_found); `error` means error, aborted,
   * not_started, not_found or server_down; a subagent's permission/question also matches its
   * parent for `needs_input`. Without a cursor, a session already in a matching state returns at
   * once; before a timeout the current state is re-read. Either way the match comes back in the
   * additive `views` field (with `events` possibly empty and timedOut false).
   * Rejects with DelegateError `cursor_expired` for a cursor from another epoch or one that fell
   * off the buffer: call oc_status, then continue without a cursor.
   */
  wait(input: { sessionIDs: string[]; until: WaitUntil[]; timeoutMs: number; cursor?: Cursor }): Promise<{ events: HubEvent[]; next: Cursor; timedOut: boolean; views?: SessionView[] }>
}

/** MOD-05: agent inbox (technical-design §7). */
export type InboxMessage = {
  id: string
  at: string
  /** `supervisor:<name>` (verified: only bridges hold the admin token) or `session:<id>` (unverified: any in-box code can claim it). */
  from: string
  to: string
  text: string
  hops: number
  verified: boolean
  correlationId?: string
}

export interface Inbox {
  /** Bridge-side post as `supervisor:<name>`. */
  post(to: string, text: string, opts?: { correlationId?: string }): Promise<InboxMessage>
  /** Messages addressed to this bridge's supervisor address, after `cursor`. */
  /**
   * `cursor` is opaque (`<epoch>.<id>`). `truncated: true` means messages after the cursor were
   * dropped by retention before they were read — never report that as "no messages". A cursor from
   * another store epoch, or past the newest id, throws `cursor_expired`.
   */
  read(cursor?: string, limit?: number): Promise<{ messages: InboxMessage[]; next: string; truncated?: boolean }>
}
