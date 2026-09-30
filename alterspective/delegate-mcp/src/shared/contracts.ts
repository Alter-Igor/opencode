// Interfaces the modules implement and the tool surface (MOD-04) consumes.
// Owned by the capability hub; modules must not change these without the hub.
import type { ApiTarget, OpencodeApi } from "./opencode-api.ts"

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
  /** Profile-time validation of MCP entries (names must start ks-). */
  validateEntries(entries: Record<string, McpEntry>): Verdict
  /** Runtime check before each send: GET /mcp for the session directory. */
  checkRuntime(api: OpencodeApi, directory: string): Promise<Verdict>
  /** Permission ruleset applied on POST /session and in the profile. */
  permissionBaseline(profile: "standard" | "readonly"): Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
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

export type HubEventType = "status" | "permission" | "question" | "message" | "error" | "todo" | "resync" | "mcp" | "inbox"

export type HubEvent = {
  cursor: Cursor
  at: string
  type: HubEventType
  sessionID?: string
  directory?: string
  state?: SessionState
  /** One line for a person or an AI. Session-originated text is never put here (see `untrusted`). */
  summary: string
  /** Text that came from a session or the box; always treated as untrusted by consumers. */
  untrusted?: string
  /** Request id for permission/question events (answer with oc_answer). */
  requestID?: string
}

export type SessionView = { sessionID: string; directory: string; state: SessionState; since: string; detail?: string; pending?: string[] }

export type WaitUntil = "idle" | "needs_input" | "error" | "message"

export interface EventHub {
  start(): Promise<void>
  stop(): Promise<void>
  /** Start tracking a session the bridge created or adopted. */
  track(sessionID: string, directory: string): void
  /** Call right after prompt_async: arms the 10 s not_started watchdog. */
  markSent(sessionID: string): void
  /** Current state; resolves absent data by reading the server (idle vs not_found). */
  view(sessionID: string): Promise<SessionView>
  /** Page of buffered events after `cursor`. A cursor from another epoch → expired:true. */
  events(cursor: Cursor | undefined, filter?: { sessionID?: string }, limit?: number): { events: HubEvent[]; next: Cursor; expired: boolean }
  /** Long-poll until a matching event, or timeout (caller caps at 240 s). */
  wait(input: { sessionIDs: string[]; until: WaitUntil[]; timeoutMs: number; cursor?: Cursor }): Promise<{ events: HubEvent[]; next: Cursor; timedOut: boolean }>
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
  read(cursor?: string, limit?: number): Promise<{ messages: InboxMessage[]; next: string }>
}
