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
  /** Additive (Wave 3): the host HEAD commit the workspace started from (diff base, instructions source). */
  base?: string
  /** Additive (Wave 3): defaults for oc_send when it names no model/agent (`provider/model`). */
  model?: string
  agent?: string
}

export type Box = { target: ApiTarget; api: OpencodeApi; hub: DelegateHub }

/** Additive (Wave 3): result of one command run on the host or in the box. */
export type CommandResult = { code: number; stdout: string; stderr: string; timedOut?: boolean }
export type CommandRunner = (argv: string[], timeoutMs?: number) => Promise<CommandResult>

export type ToolContext = {
  config: BridgeConfig
  /** `supervisor:<name>` — this bridge's inbox address and the value stored in session metadata. */
  supervisor: string
  bridgeId: string
  version: string
  log: Logger
  guard: Guard
  supervisorService: DelegateSupervisor
  /** Wave 3: the contract plus `resolveRepo` (oc_start_session checks directory_busy before cloning). */
  workspaces: Workspaces & { resolveRepo(hostRepo: string): Promise<string> }
  inbox: BridgeInbox
  /** Start or reuse the box and its event hub (idempotent, shared by concurrent calls). */
  box(): Promise<Box>
  /** Additive (Wave 3): the box this bridge already holds, without starting or reusing one. */
  peekBox(): Box | undefined
  /** Additive (Wave 3): an API client for a target read from status() (oc_doctor never starts the box). */
  apiFor(target: ApiTarget): OpencodeApi
  /** Additive (Wave 3): release this bridge's lease, then ensure again; a new target gets a new api + hub. */
  restartBox(): Promise<Box>
  /** Additive (Wave 3): called with every new Box (first start and after a restart). Returns an unsubscribe. */
  onBox(listener: (box: Box) => void): () => void
  /** Additive (Wave 3): run a command inside the box container (`docker exec <box> ...`). Output is untrusted. */
  boxExec: CommandRunner
  /** Additive (Wave 3): run a command on the host with a clean environment (git in the owner's repo). */
  hostExec: CommandRunner
  /** Sessions started by this bridge, by sessionID. */
  sessions: Map<string, SessionRecord>
  /** A fresh correlation id for one tool call (OBS-ID-01). */
  correlationId(): string
}
