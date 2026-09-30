// MOD-04 tool context: the services every tool can use, created lazily so the MCP server starts
// instantly and the box is only started by the first tool that needs it (technical-design §5).
import type { BridgeConfig } from "../shared/config.ts"
import type { Guard, Workspaces } from "../shared/contracts.ts"
import type { Logger } from "../shared/log.ts"
import type { ApiTarget, OpencodeApi } from "../shared/opencode-api.ts"
import type { DelegateHub } from "../events/index.ts"
import type { BridgeInbox } from "../inbox/index.ts"
import type { DelegateSupervisor } from "../supervisor/lifecycle.ts"

/** A session this bridge started: where it lives on the host and in the box. */
export type SessionRecord = {
  sessionID: string
  sessionKey: string
  hostRepo: string
  boxPath: string
  branch: string
  profile: "standard" | "readonly"
  createdAt: string
}

export type Box = { target: ApiTarget; api: OpencodeApi; hub: DelegateHub }

export type ToolContext = {
  config: BridgeConfig
  /** `supervisor:<name>` — this bridge's inbox address and the value stored in session metadata. */
  supervisor: string
  bridgeId: string
  version: string
  log: Logger
  guard: Guard
  supervisorService: DelegateSupervisor
  workspaces: Workspaces
  inbox: BridgeInbox
  /** Start or reuse the box and its event hub (idempotent, shared by concurrent calls). */
  box(): Promise<Box>
  /** Sessions started by this bridge, by sessionID. */
  sessions: Map<string, SessionRecord>
  /** A fresh correlation id for one tool call (OBS-ID-01). */
  correlationId(): string
}
