// MOD-01 public surface: profile, docker, leases, lifecycle, session workspaces and Keystone
// sign-in. Workspaces keep their own Exec type (`WorkspaceExec`): it differs from the docker one.
export { buildProfile, hashDirectory, writeProfile, readOwnerConfigs, nodeProfileFs, type BuiltProfile, type PermissionRule } from "./profile.ts"
export { BOX_CONTAINER, LABEL, builtFrom, bunExec, childEnv, dockerArgs, freePort, imageTag, inspectBox, requireDocker, type Exec } from "./docker.ts"
export { KILL_GRACE_MS, killTree, runProcess } from "./spawn.ts"
export { createLeases, nodeLeaseFs, renameRetry } from "./leases.ts"
export { withStartLock } from "./start-lock.ts"
export { cachedProbe, nodeProcessProbe, processAlive, type ProcessProbe } from "./process.ts"
export { containerName, siblingContainers, SIBLING_SERVICES } from "./compose-env.ts"
export { buildIdentity } from "./identity.ts"
export {
  PASSWORD_ENV, createSupervisor, defaultSupervisorDeps, paths,
  type DelegateSupervisor, type ReplaceOptions, type ReplaceResult, type SupervisorDeps, type SupervisorStatus,
} from "./lifecycle.ts"
export {
  COMMIT_ID, SESSION_KEY, createWorkspaces, runCommand,
  type CallOptions, type DelegateWorkspaces, type Exec as WorkspaceExec, type WorkspacesOptions,
} from "./workspaces.ts"
export { CALLBACK_PATH, LOGIN_PORT, LOGIN_TIMEOUT_MS, defaultOpener, login, type LoginOptions } from "./login.ts"
