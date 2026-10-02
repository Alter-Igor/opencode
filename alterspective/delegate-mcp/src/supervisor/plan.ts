// MOD-01: what one start (or one reuse check) is made of, for the Keystone set in force now
// (review R4-01): the profile (its MCP entries are the chosen ks-<id> connections), the MCP allow
// policy (from the same config) and front's generated servers file (only those connections'
// Keystone paths). All three come from ONE effective config, so they can never disagree.
import { effectiveConfig, type BridgeConfig } from "../shared/config.ts"
import { keystoneIds } from "../shared/keystone.ts"
import { enforceCeiling } from "../shared/keystone-policy.ts"
import { frontConfigHash, frontServersFor } from "../guard/egress.ts"
import { keystoneHostAuth } from "../guard/egress-identity.ts"
import type { Run } from "./run.ts"
import { FALLBACK_MODELS, type RegisteredModels } from "../synapse/models.ts"
import type { FrontFiles } from "./compose-env.ts"
import type { SupervisorDeps } from "./lifecycle.ts"
import { buildProfile, readOwnerConfigs, withRegisteredModels, type BuiltProfile } from "./profile.ts"

export type Plan = {
  /** deps.config with keystoneConnections = the set this plan is for. */
  config: BridgeConfig
  built: BuiltProfile
  front: FrontFiles
  /**
   * #67 review: the profile hash this plan would have with OCD_KEYSTONE_HOST_AUTH the other way.
   * A running box with this hash was started by a bridge whose flag differs, and the refusal says so.
   */
  otherFlagHash?: string
}

type PlanDeps = Pick<SupervisorDeps, "config" | "profileFs" | "ownerConfigDir" | "permission" | "keyEnv" | "frontAuth">

/** front's generated servers file for a config whose keystoneConnections is the effective set. */
export function frontFilesFor(config: BridgeConfig): FrontFiles {
  const servers = frontServersFor(config)
  return { servers, hash: frontConfigHash(servers) }
}

/**
 * The plan for `keystone` when given (oc_server_restart {keystone}; validated here, not saved),
 * else for the saved / default set. Throws profile_invalid for a bad owner config or a damaged
 * saved set, invalid_input for a bad id, and policy_violation for an id outside the owner's
 * ceiling (R5-03), so a refused set never stops or starts anything.
 */
export async function planFor(deps: PlanDeps, keystone?: readonly string[]): Promise<Plan> {
  const config = keystone ? { ...deps.config, keystoneConnections: keystoneIds(keystone) } : effectiveConfig(deps.config)
  enforceCeiling(config.keystoneConnections, deps.config)
  const ownerConfigs = await readOwnerConfigs(deps.profileFs, deps.ownerConfigDir)
  const input = { ownerConfigs, config, permission: deps.permission, keyEnv: deps.keyEnv, frontAuth: deps.frontAuth }
  const hostAuth = keystoneHostAuth()
  const built = buildProfile({ ...input, hostAuth })
  // With no Keystone entry chosen the flag changes nothing in the profile: both hashes are equal,
  // and a matching box must never be read as a flag mismatch (review cycle 2, High).
  const other = buildProfile({ ...input, hostAuth: !hostAuth }).hash
  return { config, built, front: frontFilesFor(config), ...(other !== built.hash ? { otherFlagHash: other } : {}) }
}

const UNSET: RegisteredModels & { source: "fallback" } = { models: [...FALLBACK_MODELS], limits: {}, source: "fallback", reason: "the bridge reads no Synapse model list (no registeredModels)" }

/**
 * #71, at box start only (never on a reuse check, which runs every few minutes): the plan with
 * the models registered in Synapse now. Never throws: an unreadable list gives `auto` only, said
 * in the log, and the box still starts. The profile hash is unchanged (MODELS_FILE is outside it).
 */
export async function withSynapseModels(deps: Pick<SupervisorDeps, "registeredModels">, plan: Plan, note: Run["note"]): Promise<Plan> {
  const registered = deps.registeredModels ? await deps.registeredModels().catch((): RegisteredModels => ({ ...UNSET, reason: "reading the Synapse model list failed" })) : UNSET
  const built = withRegisteredModels(plan.built, registered)
  if (registered.source === "fallback") note("warn", "Synapse model list unavailable; the box offers synapse/auto only", { reason: registered.reason })
  else note("info", "box models from Synapse", { count: built.offered.length })
  const models = built.dropped.filter((d) => d.provider === "model" || d.provider === "small_model")
  if (models.length) note("warn", "owner default model not registered in Synapse; synapse/auto is used", { keys: models.map((d) => d.provider).join(",") })
  return { ...plan, built }
}
