// MOD-01 T1.3: Supervisor.ensure/status/release (contracts.ts, technical-design.md §4).
// Start, reuse and stop all run under the host start lock, and this bridge's lease is taken
// before any health wait, so another bridge's release can never stop a box this bridge is
// about to use (A-02). Every public call is logged with the bridge id and a correlation id.
// A running set is reused only when the box AND its egress/cache siblings match (N-9).
import { chmod, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { mcpAllowPolicy, type BridgeConfig } from "../shared/config.ts"
import type { Supervisor } from "../shared/contracts.ts"
import { DelegateError } from "../shared/errors.ts"
import type { Logger } from "../shared/log.ts"
import type { ApiTarget } from "../shared/opencode-api.ts"
import { INSPECT_ENV, MCP_ALLOW_ENV, approvedValues, boxEnvOverride, composeDownEnv, composeEnv, siblingContainers } from "./compose-env.ts"
import { LABEL, dockerArgs, imageExists, inspectBox, redactAll, requireDocker, type BoxInspect, type Exec, type ExecResult } from "./docker.ts"
import { waitHealthy } from "./health.ts"
import type { LeaseFs } from "./leases.ts"
import type { ProcessProbe } from "./process.ts"
import { buildProfile, fsFailure, readOwnerConfigs, writeProfile, type BuiltProfile, type PermissionRule, type ProfileFs } from "./profile.ts"
import { createContext, lockOptions, traced, withLease, type Run } from "./run.ts"
import { withStartLock, type Every } from "./start-lock.ts"
import { statusOf, targetOf, type DelegateSupervisor } from "./status.ts"

export { PASSWORD_ENV, boxEnvOverride, composeDownEnv, composeEnv, paths, siblingContainers } from "./compose-env.ts"
export { defaultSupervisorDeps } from "./deps.ts"
export { targetOf, type DelegateSupervisor, type SupervisorStatus } from "./status.ts"

export type SupervisorDeps = {
  config: BridgeConfig
  bridgeId: string
  pid: number
  /** Full image reference, e.g. opencode-delegate-box:1.18.31-1483a47 (or ...-dirty-<hash>). */
  image: string
  /** OpenCode version stamped into the binary when the image has to be built. */
  opencodeVersion: string
  composeFile: string
  ownerConfigDir: string
  /** From MOD-02 Guard.permissionBaseline("standard"). */
  permission: PermissionRule[]
  keyEnv?: Record<string, string>
  hostEnv: NodeJS.ProcessEnv
  exec: Exec
  profileFs: ProfileFs
  leaseFs: LeaseFs
  probe: ProcessProbe
  fetch: typeof fetch
  freePort: () => Promise<number>
  randomPassword: () => string
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Timer used for lease and lock heartbeats (tests pass a manual one). */
  every?: Every
  healthTimeoutMs?: number
  lockWaitMs?: number
  login?: Supervisor["login"]
  log?: Logger
}

async function currentProfile(run: Run): Promise<BuiltProfile> {
  const { deps } = run
  const ownerConfigs = await readOwnerConfigs(deps.profileFs, deps.ownerConfigDir)
  return buildProfile({ ownerConfigs, config: deps.config, permission: deps.permission, keyEnv: deps.keyEnv })
}

function changed(message: string, detail: string): DelegateError {
  return new DelegateError("profile_changed", message, "Restart the sandbox with oc_server_restart, or close the other sessions so it restarts with this bridge's settings.", detail)
}

/** A running box is only reused when profile, image and MCP policy all match this bridge (A-04, A-05). */
export function checkReusable(deps: SupervisorDeps, box: BoxInspect, hash: string): void {
  if (box.labels[LABEL.profileHash] !== hash)
    throw changed("The running sandbox uses an older profile (config, model list or permissions changed).", `profile hash ${box.labels[LABEL.profileHash]?.slice(0, 12) ?? "missing"} != ${hash.slice(0, 12)}`)
  if (box.labels[LABEL.image] !== deps.image)
    throw changed("The running sandbox was built from a different OpenCode checkout.", `image ${box.labels[LABEL.image] ?? "missing"} != ${deps.image}`)
  if (box.env[MCP_ALLOW_ENV] !== mcpAllowPolicy(deps.config))
    throw changed("The running sandbox has a different MCP allow policy than this bridge.", `${MCP_ALLOW_ENV} ${box.env[MCP_ALLOW_ENV] === undefined ? "missing" : "differs"}`)
}

/** egress and the caches must come from the same checkout as the box (review N-9). */
export async function checkSiblings(run: Run): Promise<void> {
  const { deps } = run
  for (const { service, container } of siblingContainers(deps.config)) {
    const sibling = await inspectBox(deps.exec, [], container)
    const label = sibling?.labels[LABEL.image]
    if (label !== deps.image)
      throw changed(
        `The running sandbox's ${service} service was built from a different OpenCode checkout.`,
        `${service} ${sibling ? `image label ${label ?? "missing"}` : "container missing"} != ${deps.image}`,
      )
  }
}

async function reuse(run: Run, box: BoxInspect, hash: string): Promise<ApiTarget> {
  checkReusable(run.deps, box, hash)
  await checkSiblings(run)
  const target = targetOf(box, run.deps.config.project)
  return withLease(run, async () => {
    await waitHealthy(run.deps, target, run.container)
    run.note("info", "reusing running sandbox", { health: box.health })
    return target
  })
}

async function prepareFiles(run: Run, built: BuiltProfile): Promise<void> {
  const { deps, dirs } = run
  const onDisk = await writeProfile(deps.profileFs, dirs.profile, built.files)
  if (onDisk !== built.hash)
    throw new DelegateError("profile_invalid", "The profile on disk does not match what was built.", "Retry; check that nothing else writes the profile folder.", `on disk ${onDisk.slice(0, 12)} != built ${built.hash.slice(0, 12)}`)
  try {
    // Both bind sources must exist before `up`, or Docker creates them root-owned (review C-4).
    await mkdir(path.join(dirs.handoff, "in"), { recursive: true })
    const out = path.join(dirs.handoff, "out")
    await mkdir(out, { recursive: true })
    const mode = handoffOutMode(process.platform)
    if (mode !== undefined) await chmod(out, mode)
    await writeBoxEnvOverride(run)
  } catch (error) {
    throw fsFailure("prepare the sandbox folders", error, deps.config.home)
  }
}

/**
 * Mode for <home>/handoff/out on the host (review N-12, docker/box/README.md). On a Linux Docker
 * host the bind mount keeps host ownership, and the box user (uid 10001) must write its bundle
 * there, so the folder is opened to all (0777). Safe because the host never runs anything from
 * it and takes each bundle by rename into a host-only folder, then checks type and size
 * (workspaces-handoff.ts). On Windows, Docker Desktop maps permissions itself and POSIX modes
 * mean nothing to NTFS, so the folder is left alone.
 */
export function handoffOutMode(platform: NodeJS.Platform): number | undefined {
  return platform === "win32" ? undefined : 0o777
}

async function writeBoxEnvOverride(run: Run): Promise<void> {
  await writeFile(run.dirs.boxEnvOverride, boxEnvOverride(run.deps.config.boxEnv), "utf8")
}

const PORT_BUSY = /port is already allocated|address already in use|Only one usage of each socket address/i

export function upFailure(result: ExecResult, secrets: string[]): DelegateError {
  const detail = `exit ${result.code}: ${redactAll(result.stderr, secrets).slice(-600)}`
  if (PORT_BUSY.test(result.stderr))
    return new DelegateError("port_busy", "The sandbox port on this computer is already in use.", "Retry; the bridge picks a new port each start. Run oc_doctor if it repeats.", detail)
  return new DelegateError("server_down", "The sandbox failed to start.", "Run oc_doctor; check Docker Desktop.", detail)
}

async function start(run: Run, built: BuiltProfile): Promise<ApiTarget> {
  const { deps } = run
  return withLease(run, async () => {
    await prepareFiles(run, built)
    const password = deps.randomPassword()
    const port = await deps.freePort()
    // MOD-05: the inbox admin port and token are made per start, like the password (compose-env.ts).
    const inboxPort = await deps.freePort()
    const inbox = { port: inboxPort === port ? await deps.freePort() : inboxPort, token: deps.randomPassword() }
    const build = !(await imageExists(deps.exec, deps.image))
    run.note("info", "starting sandbox", { image: deps.image, build, port, inboxPort: inbox.port, profileHash: built.hash.slice(0, 12) })
    const result = await deps.exec(dockerArgs.up(run.compose, build), { env: composeEnv(deps, built, port, password, inbox), timeoutMs: 20 * 60_000 })
    if (result.code !== 0) throw upFailure(result, [password, inbox.token, ...Object.values(approvedValues(deps))])
    const target = { baseUrl: `http://127.0.0.1:${port}`, password }
    await waitHealthy(deps, target, run.container)
    run.state.startedHere = true
    return target
  })
}

async function ensure(run: Run): Promise<ApiTarget> {
  const { deps } = run
  await requireDocker(deps.exec)
  const built = await currentProfile(run)
  if (built.dropped.length) run.note("warn", "providers left out of the box profile", { dropped: built.dropped.map((d) => d.provider).join(",") })
  await mkdir(deps.config.home, { recursive: true }).catch((error: unknown) => {
    throw fsFailure("create the bridge home folder", error, deps.config.home)
  })
  return withStartLock(deps.leaseFs, run.dirs.startLock, async () => {
    const box = await inspectBox(deps.exec, INSPECT_ENV, run.container)
    return box?.running ? reuse(run, box, built.hash) : start(run, built)
  }, await lockOptions(run))
}

async function release(run: Run): Promise<void> {
  if (!run.state.leased) return run.note("info", "release: this bridge holds no lease; nothing to stop")
  await withStartLock(run.deps.leaseFs, run.dirs.startLock, async () => {
    // Waits for a heartbeat already in flight, so it cannot re-create the lease (review N-10).
    await run.stopHeartbeat()
    const remaining = await run.leases.release(run.deps.bridgeId)
    run.state.leased = false
    if (remaining > 0) return run.note("info", "lease released; sandbox kept", { remaining })
    // Same -f files as `up`, from the bridge home, never the process working folder (review N-1).
    await writeBoxEnvOverride(run).catch((error: unknown) => {
      throw fsFailure("prepare the sandbox stop", error, run.dirs.boxEnvOverride)
    })
    const result = await run.deps.exec(dockerArgs.down(run.compose), { env: composeDownEnv(run.deps), cwd: run.deps.config.home, timeoutMs: 120_000 })
    if (result.code !== 0) {
      const detail = `exit ${result.code}: ${result.stderr.trim().slice(-400)}`
      run.note("error", "stop failed", { code: result.code, detail })
      throw new DelegateError("sandbox_unavailable", "The sandbox did not stop.", `Run \`docker compose -p ${run.deps.config.project} down\`, or oc_doctor.`, detail)
    }
    run.state.startedHere = false
    run.note("info", "last lease released; sandbox stopped")
  }, await lockOptions(run))
}

export function createSupervisor(deps: SupervisorDeps): DelegateSupervisor {
  const ctx = createContext(deps)
  return {
    ensure: () => traced(ctx, "ensure", ensure),
    status: () => traced(ctx, "status", statusOf),
    release: () => traced(ctx, "release", release),
    login: (entry, opener) =>
      traced(ctx, "login", async () => {
        if (!deps.login) throw new DelegateError("upstream_error", "Sign-in is not wired into this bridge.", "Update the bridge.")
        return deps.login(entry, opener)
      }, "upstream_error"),
  }
}
