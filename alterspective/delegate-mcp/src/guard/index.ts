// MOD-02 policy guard: the Guard contract (shared/contracts.ts) bound to a BridgeConfig.
import { currentKeystone, type BridgeConfig } from "../shared/config.ts"
import type { Guard, Verdict } from "../shared/contracts.ts"
import { validateEntries } from "./entries.ts"
import { checkPermissionReply, permissionBaseline } from "./permissions.ts"
import { checkRuntime } from "./runtime.ts"

type GuardConfig = Pick<BridgeConfig, "keystoneOrigin" | "home" | "keystoneConnections">

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
  return {
    validateEntries: (entries) => {
      const connections = chosen(config)
      return Array.isArray(connections) ? validateEntries(entries, config.keystoneOrigin, connections) : connections
    },
    checkRuntime: async (api, directory) => {
      const connections = chosen(config)
      return Array.isArray(connections) ? checkRuntime(api, directory, connections) : connections
    },
    permissionBaseline,
    checkPermissionReply,
  }
}

export { KS_NAME, validateEntries } from "./entries.ts"
export { checkRuntime, judgeMcpStatus } from "./runtime.ts"
export { checkPermissionReply, permissionBaseline, type Rule } from "./permissions.ts"
export { egressHostList, frontHosts, frontServers, REGISTRY_HOSTS } from "./egress.ts"
export { checkEgress, type EgressCheck } from "./egress-check.ts"
