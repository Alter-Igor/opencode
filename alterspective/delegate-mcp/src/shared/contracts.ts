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

export type McpEntry = { type?: string; url?: string; headers?: Record<string, string>; oauth?: unknown; enabled?: boolean }

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
