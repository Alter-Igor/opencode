// MOD-02 policy guard: the Guard contract (shared/contracts.ts) bound to a BridgeConfig.
import { currentKeystone, type BridgeConfig } from "../shared/config.ts"
import type { Guard, Verdict } from "../shared/contracts.ts"
import { validateEntries } from "./entries.ts"
import { checkPermissionReply, permissionBaseline, toolDenyRules } from "./permissions.ts"
import { checkRuntime } from "./runtime.ts"
import { parseProfile } from "../../mcp-gate/src/policy.ts"

type GuardConfig = Pick<BridgeConfig, "keystoneOrigin" | "home" | "keystoneConnections" | "keystoneAllowed" | "keystoneToolDeny" | "dynamicProfile">

/**
 * #104: whether the delegation gate holds every risky dynamic call for an approval: the default
 * profile, or one with approvals "risky". "listed", or a profile that cannot be read (the box would
 * not start with it anyway), keeps read-only sessions asking before each dynamic call.
 */
export function gateAsksForRisky(profile: string): boolean {
  if (profile === "") return true
  try {
    return (parseProfile(profile).approvals ?? "risky") === "risky"
  } catch {
    return false
  }
}

/**
 * The chosen Keystone set, read on every check (another bridge may have changed it), or the
 * policy_unverified verdict when the saved choice is damaged (fails closed).
 */
function chosen(config: GuardConfig): string[] | Verdict {
  try {
    return currentKeystone(config).connections
  } catch (error) {
    return { ok: false, code: "policy_unverified", reason: error instanceof Error ? error.message : "the chosen Keystone set could not be read" }
  }
}

export function createGuard(config: GuardConfig): Guard {
  const dynamicGated = gateAsksForRisky(config.dynamicProfile)
  return {
    validateEntries: (entries) => {
      const connections = chosen(config)
      return Array.isArray(connections) ? validateEntries(entries, config.keystoneOrigin, connections) : connections
    },
    checkRuntime: async (api, directory) => {
      const connections = chosen(config)
      return Array.isArray(connections) ? checkRuntime(api, directory, connections) : connections
    },
    // R5-02: the deny list goes LAST, in the profile and in every session (the same function makes
    // both), so neither the `ks-*_*` allow nor a session's narrowing can give a denied tool back.
    permissionBaseline: (profile, keystone) => [...permissionBaseline(profile, keystone, dynamicGated), ...toolDenyRules(config.keystoneToolDeny)],
    checkPermissionReply,
  }
}

export { KS_NAME, validateEntries } from "./entries.ts"
export { checkRuntime, judgeMcpStatus } from "./runtime.ts"
export { checkPermissionReply, permissionBaseline, toolDenyRules, type Rule } from "./permissions.ts"
export { egressHostList, frontHosts, frontServers, REGISTRY_HOSTS } from "./egress.ts"
export { checkEgress, type EgressCheck } from "./egress-check.ts"
