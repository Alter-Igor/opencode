// MOD-01 public surface (profile, docker, leases, lifecycle). workspaces.ts and login.ts are
// owned by a separate build agent and exported from here by the hub once they land.
export { buildProfile, hashDirectory, writeProfile, readOwnerConfigs, nodeProfileFs, type BuiltProfile, type PermissionRule } from "./profile.ts"
export { BOX_CONTAINER, LABEL, bunExec, childEnv, dockerArgs, freePort, imageTag, inspectBox, requireDocker, type Exec } from "./docker.ts"
export { createLeases, nodeLeaseFs } from "./leases.ts"
export { withStartLock } from "./start-lock.ts"
export { nodeProcessProbe, processAlive, type ProcessProbe } from "./process.ts"
export { containerName } from "./compose-env.ts"
export { buildIdentity } from "./identity.ts"
export {
  PASSWORD_ENV, createSupervisor, defaultSupervisorDeps, paths,
  type DelegateSupervisor, type SupervisorDeps, type SupervisorStatus,
} from "./lifecycle.ts"
