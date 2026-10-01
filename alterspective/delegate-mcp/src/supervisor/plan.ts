// MOD-01: what one start (or one reuse check) is made of, for the Keystone set in force now
// (review R4-01): the profile (its MCP entries are the chosen ks-<id> connections), the MCP allow
// policy (from the same config) and front's generated servers file (only those connections'
// Keystone paths). All three come from ONE effective config, so they can never disagree.
import { effectiveConfig, type BridgeConfig } from "../shared/config.ts"
import { keystoneIds } from "../shared/keystone.ts"
import { frontConfigHash, frontServersFor } from "../guard/egress.ts"
import type { FrontFiles } from "./compose-env.ts"
import type { SupervisorDeps } from "./lifecycle.ts"
import { buildProfile, readOwnerConfigs, type BuiltProfile } from "./profile.ts"

export type Plan = {
  /** deps.config with keystoneConnections = the set this plan is for. */
  config: BridgeConfig
  built: BuiltProfile
  front: FrontFiles
}

type PlanDeps = Pick<SupervisorDeps, "config" | "profileFs" | "ownerConfigDir" | "permission" | "keyEnv">

/** front's generated servers file for a config whose keystoneConnections is the effective set. */
export function frontFilesFor(config: BridgeConfig): FrontFiles {
  const servers = frontServersFor(config)
  return { servers, hash: frontConfigHash(servers) }
}

/**
 * The plan for `keystone` when given (oc_server_restart {keystone}; validated here, not saved),
 * else for the saved / default set. Throws profile_invalid for a bad owner config or a damaged
 * saved set, and invalid_input for a bad id.
 */
export async function planFor(deps: PlanDeps, keystone?: readonly string[]): Promise<Plan> {
  const config = keystone ? { ...deps.config, keystoneConnections: keystoneIds(keystone) } : effectiveConfig(deps.config)
  const ownerConfigs = await readOwnerConfigs(deps.profileFs, deps.ownerConfigDir)
  const built = buildProfile({ ownerConfigs, config, permission: deps.permission, keyEnv: deps.keyEnv })
  return { config, built, front: frontFilesFor(config) }
}
