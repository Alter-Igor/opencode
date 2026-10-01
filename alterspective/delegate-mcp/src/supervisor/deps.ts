// MOD-01: production wiring for the supervisor: real docker CLI, real files, owner config
// from ~/.config/opencode, and the image named after its build inputs (identity.ts).
import { randomBytes } from "node:crypto"
import os from "node:os"
import path from "node:path"
import type { BridgeConfig } from "../shared/config.ts"
import type { Supervisor } from "../shared/contracts.ts"
import type { Logger } from "../shared/log.ts"
import { bunExec, freePort, type Exec } from "./docker.ts"
import { buildIdentity } from "./identity.ts"
import { nodeLeaseFs } from "./leases.ts"
import type { SupervisorDeps } from "./lifecycle.ts"
import { nodeProcessProbe } from "./process.ts"
import { nodeProfileFs, type PermissionRule } from "./profile.ts"

export type DefaultDepsOptions = {
  bridgeId: string
  permission: PermissionRule[]
  repoRoot: string
  log?: Logger
  login?: Supervisor["login"]
  /** Tests only: the command runner used for git (docker calls always use it too). */
  exec?: Exec
  ownerConfigDir?: string
}

export async function defaultSupervisorDeps(config: BridgeConfig, options: DefaultDepsOptions): Promise<SupervisorDeps> {
  const exec = options.exec ?? bunExec
  const identity = await buildIdentity(options.repoRoot, config.image, exec)
  options.log?.log("info", "supervisor", "sandbox image identity", { image: identity.image, sha: identity.sha, dirty: identity.dirty !== undefined, bridgeId: options.bridgeId })
  return {
    config,
    bridgeId: options.bridgeId,
    pid: process.pid,
    image: identity.image,
    buildSha: identity.sha,
    opencodeVersion: identity.opencodeVersion,
    composeFile: path.join(options.repoRoot, "alterspective", "delegate-mcp", "docker", "compose.yaml"),
    ownerConfigDir: options.ownerConfigDir ?? path.join(os.homedir(), ".config", "opencode"),
    permission: options.permission,
    // WS2 (#48): no Synapse key in the box; front sets the owner's delegated token.
    frontAuth: ["synapse"],
    hostEnv: process.env,
    exec,
    profileFs: nodeProfileFs,
    leaseFs: nodeLeaseFs,
    probe: nodeProcessProbe,
    fetch,
    freePort,
    randomPassword: () => randomBytes(24).toString("base64url"),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    log: options.log,
    login: options.login,
  }
}
