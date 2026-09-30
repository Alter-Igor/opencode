// MOD-02 policy guard: the Guard contract (shared/contracts.ts) bound to a BridgeConfig.
import type { BridgeConfig } from "../shared/config.ts"
import type { Guard } from "../shared/contracts.ts"
import { validateEntries } from "./entries.ts"
import { checkPermissionReply, permissionBaseline } from "./permissions.ts"
import { checkRuntime } from "./runtime.ts"

export function createGuard(config: Pick<BridgeConfig, "keystoneOrigin">): Guard {
  return {
    validateEntries: (entries) => validateEntries(entries, config.keystoneOrigin),
    checkRuntime,
    permissionBaseline,
    checkPermissionReply,
  }
}

export { KS_NAME, KS_PATH, validateEntries } from "./entries.ts"
export { checkRuntime, judgeMcpStatus } from "./runtime.ts"
export { checkPermissionReply, permissionBaseline, type Rule } from "./permissions.ts"
export { egressAllowlist, REGISTRY_HOSTS } from "./egress.ts"
