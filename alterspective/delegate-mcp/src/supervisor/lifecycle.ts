// MOD-01 T1.3: Supervisor.ensure/status/release (contracts.ts, technical-design.md §4).
// Start, reuse and stop all run under the host start lock, and this bridge's lease is taken
// before any health wait, so another bridge's release can never stop a box this bridge is
// about to use (A-02). Every public call is logged with the bridge id and a correlation id.
// A running set is reused only when the box AND its front/cache siblings match (N-9).
// replace() (oc_server_restart) is the way out of profile_changed: down + start under the lock.
// It can also change the box-wide Keystone set (review R4-01), saved in the bridge home.
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { removeLegacyOut, sweepOutBundles } from "./handoff-hygiene.ts"
import { mcpAllowPolicy, type BridgeConfig } from "../shared/config.ts"
import { saveKeystoneSet } from "../shared/keystone.ts"
import type { Supervisor } from "../shared/contracts.ts"
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import type { Logger } from "../shared/log.ts"
import type { ApiTarget } from "../shared/opencode-api.ts"
import { FRONT_SERVERS_NAME } from "../guard/egress.ts"
import { ensureAuthConf, ensureKsAuthConf } from "../synapse/auth-conf.ts"
import { KEYSTONE_HOST_AUTH_ENV, keystoneHostAuth } from "../guard/egress-identity.ts"
import { SYNAPSE_LOCK_WAIT_MS } from "../synapse/lock.ts"
import { INSPECT_ENV, MCP_ALLOW_ENV, approvedValues, boxEnvOverride, composeDownEnv, composeEnv, siblingContainers } from "./compose-env.ts"
import { LABEL, dockerArgs, imageExists, inspectBox, redactAll, requireDocker, type BoxInspect, type Exec, type ExecResult } from "./docker.ts"
import { waitHealthy } from "./health.ts"
import { pruneSignIns, verifyLive } from "./live.ts"
import type { LeaseFs } from "./leases.ts"
import type { ProcessProbe } from "./process.ts"
import { planFor, type Plan } from "./plan.ts"
import { fsFailure, writeProfile, type PermissionRule, type ProfileFs } from "./profile.ts"
import { createContext, lockOptions, traced, withLease, type Run } from "./run.ts"
import { withStartLock, type Every } from "./start-lock.ts"
import { statusOf, targetOf, type DelegateSupervisor, type ReplaceOptions, type ReplaceResult } from "./status.ts"

export { PASSWORD_ENV, boxEnvOverride, composeDownEnv, composeEnv, paths, siblingContainers } from "./compose-env.ts"
export { defaultSupervisorDeps } from "./deps.ts"
export { targetOf, type DelegateSupervisor, type ReplaceOptions, type ReplaceResult, type SupervisorStatus } from "./status.ts"

export type SupervisorDeps = {
  config: BridgeConfig
  bridgeId: string
  pid: number
  /** Full image reference, e.g. opencode-delegate-box:1.18.31-<12 hex content hash> (or ...-dirty-<hash>). */
  image: string
  /** Information only: git short sha of the checkout (doctor shows it; never used for reuse). */
  buildSha?: string
  /** OpenCode version stamped into the binary when the image has to be built. */
  opencodeVersion: string
  composeFile: string
  ownerConfigDir: string
  /** From MOD-02 Guard.permissionBaseline("standard"). */
  permission: PermissionRule[]
  keyEnv?: Record<string, string>
  /** WS2 (#48): providers whose credential front sets (profile.ts frontAuth). */
  frontAuth?: string[]
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

/** What to do about a sandbox that does not fit this bridge: oc_server_restart replaces it (force when others hold it). */
export function restartAction(others: number): string {
  if (others <= 0) return "Call oc_server_restart with confirm: true; it replaces the sandbox with one built from this bridge's settings."
  const who = others === 1 ? "1 other bridge is" : `${others} other bridges are`
  return `${who} using the sandbox: call oc_server_restart with confirm: true and force: true to replace it anyway (their running sessions are interrupted), or close those bridges first.`
}

function changed(message: string, detail: string): DelegateError {
  return new DelegateError("profile_changed", message, restartAction(0), detail)
}

/** Live leases of other bridges (dead ones are pruned). */
async function otherLeases(run: Run): Promise<number> {
  return (await run.leases.active()).filter((id) => id !== run.deps.bridgeId).length
}

/** A profile_changed from the reuse checks says how many other bridges hold the box, so its action names force when needed. */
async function withHolders(run: Run, error: unknown): Promise<unknown> {
  if (!isDelegateError(error) || error.code !== "profile_changed") return error
  const others = await otherLeases(run).catch(() => 0)
  return new DelegateError(error.code, error.message, restartAction(others), error.detail)
}

/**
 * A running box is only reused when profile, image and MCP policy all match this bridge (A-04,
 * A-05). The profile hash covers the ks-<id> entries, so another Keystone set fails here too.
 */
export function checkReusable(deps: SupervisorDeps, box: BoxInspect, plan: Pick<Plan, "built" | "config" | "otherFlagHash">): void {
  const hash = plan.built.hash
  if (plan.otherFlagHash !== undefined && plan.otherFlagHash !== hash && box.labels[LABEL.profileHash] === plan.otherFlagHash) {
    const on = keystoneHostAuth()
    throw changed(
      `The running sandbox was started by a bridge with ${KEYSTONE_HOST_AUTH_ENV} ${on ? "unset" : "=1"}, but this bridge has it ${on ? "=1" : "unset"}. Set ${KEYSTONE_HOST_AUTH_ENV} the same for every bridge that shares this home.`,
      `profile hash ${hash.slice(0, 12)} differs only by ${KEYSTONE_HOST_AUTH_ENV}`,
    )
  }
  if (box.labels[LABEL.profileHash] !== hash)
    throw changed("The running sandbox uses an older profile (config, model list or permissions changed).", `profile hash ${box.labels[LABEL.profileHash]?.slice(0, 12) ?? "missing"} != ${hash.slice(0, 12)}`)
  if (box.labels[LABEL.image] !== deps.image)
    throw changed("The running sandbox was built from a different OpenCode checkout.", `image ${box.labels[LABEL.image] ?? "missing"} != ${deps.image}`)
  if (box.env[MCP_ALLOW_ENV] !== mcpAllowPolicy(plan.config))
    throw changed("The running sandbox has a different MCP allow policy than this bridge.", `${MCP_ALLOW_ENV} ${box.env[MCP_ALLOW_ENV] === undefined ? "missing" : "differs"}`)
}

/** front must have been started with the servers file of this plan's Keystone set (review R4-01). */
function checkFrontConfig(service: string, sibling: BoxInspect | undefined, plan: Pick<Plan, "front">): void {
  if (service !== "front") return
  const label = sibling?.labels[LABEL.frontConfig]
  if (label !== plan.front.hash)
    throw changed("The running sandbox's front proxy allows a different set of Keystone services.", `front-config ${label?.slice(0, 12) ?? "missing"} != ${plan.front.hash.slice(0, 12)}`)
}

/**
 * front, the caches and the inbox must come from the same checkout as the box (review N-9) and
 * must be running (W2C-12): reusing a box whose inbox or proxy has stopped would give a sandbox
 * that half works. front must also carry this plan's generated config.
 */
export async function checkSiblings(run: Run, plan: Pick<Plan, "front">): Promise<void> {
  const { deps } = run
  for (const { service, container } of siblingContainers(deps.config)) {
    const sibling = await inspectBox(deps.exec, [], container)
    const label = sibling?.labels[LABEL.image]
    if (label !== deps.image)
      throw changed(
        `The running sandbox's ${service} service was built from a different OpenCode checkout.`,
        `${service} ${sibling ? `image label ${label ?? "missing"}` : "container missing"} != ${deps.image}`,
      )
    checkFrontConfig(service, sibling, plan)
    if (!sibling?.running)
      throw new DelegateError(
        "sandbox_unavailable",
        `The running sandbox's ${service} service is stopped.`,
        "Restart the sandbox with oc_server_restart, or run oc_doctor.",
        `${service} container not running`,
      )
  }
}

async function reuse(run: Run, box: BoxInspect, plan: Plan): Promise<ApiTarget> {
  try {
    checkReusable(run.deps, box, plan)
    await checkSiblings(run, plan)
  } catch (error) {
    throw await withHolders(run, error)
  }
  const target = targetOf(box, run.deps.config.project)
  return withLease(run, async () => {
    await waitHealthy(run.deps, target, run.container)
    // R5-01: sign-ins of entries that left the set must not stay in the box, even on reuse.
    await pruneSignIns(run, plan)
    await sweepOutBundles(run)
    run.note("info", "reusing running sandbox", { health: box.health })
    return target
  })
}

async function prepareFiles(run: Run, plan: Plan): Promise<void> {
  const { deps, dirs } = run
  const built = plan.built
  const onDisk = await writeProfile(deps.profileFs, dirs.profile, built.files)
  if (onDisk !== built.hash)
    throw new DelegateError("profile_invalid", "The profile on disk does not match what was built.", "Retry; check that nothing else writes the profile folder.", `on disk ${onDisk.slice(0, 12)} != built ${built.hash.slice(0, 12)}`)
  try {
    // The bind source must exist before `up`, or Docker creates it root-owned (review C-4).
    // There is no host out/ folder: the box's out/ is a box-only volume (G-7).
    await mkdir(path.join(dirs.handoff, "in"), { recursive: true })
    await removeLegacyOut(run)
    await writeBoxEnvOverride(run)
    await mkdir(dirs.front, { recursive: true })
    await mkdir(path.dirname(dirs.synapseLock), { recursive: true })
  } catch (error) {
    throw fsFailure("prepare the sandbox folders", error, deps.config.home)
  }
  // Review N1: front's generated files are written under the Synapse refresh lock (src/synapse/lock.ts),
  // so a token refresh never reloads front between its check and a file written here. The caller
  // holds the start lock: start lock first, then this one (the Synapse code never takes the start lock).
  await withStartLock(deps.leaseFs, dirs.synapseLock, async () => {
    try {
      // front's servers for this Keystone set (R4-01); compose mounts the folder read-only into front.
      await writeFile(path.join(dirs.front, FRONT_SERVERS_NAME), plan.front.servers, "utf8")
      // WS2 (#48): servers.conf includes the Synapse auth file, so it must exist (empty = no credential).
      await ensureAuthConf(dirs.front)
      // #67 step 4: with host-held Keystone tokens servers.conf includes one ks-auth-<id>.conf per
      // chosen connection, so each must exist (empty = no credential until the host publishes one).
      if (keystoneHostAuth()) await ensureKsAuthConf(dirs.front, plan.config.keystoneConnections)
    } catch (error) {
      throw fsFailure("write front's generated files", error, deps.config.home)
    }
  }, { ...(await lockOptions(run)), waitMs: SYNAPSE_LOCK_WAIT_MS, staleMs: SYNAPSE_LOCK_WAIT_MS })
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

async function start(run: Run, plan: Plan): Promise<ApiTarget> {
  const { deps } = run
  return withLease(run, async () => {
    await prepareFiles(run, plan)
    const password = deps.randomPassword()
    const port = await deps.freePort()
    // MOD-05: the inbox admin port and token are made per start, like the password (compose-env.ts).
    const inboxPort = await deps.freePort()
    const inbox = { port: inboxPort === port ? await deps.freePort() : inboxPort, token: deps.randomPassword() }
    const build = !(await imageExists(deps.exec, deps.image))
    run.note("info", "starting sandbox", { image: deps.image, build, port, inboxPort: inbox.port, profileHash: plan.built.hash.slice(0, 12), keystone: plan.config.keystoneConnections.join(",") })
    const env = composeEnv({ ...deps, config: plan.config }, { built: plan.built, port, password, inbox, front: plan.front })
    const result = await deps.exec(dockerArgs.up(run.compose, build), { env, timeoutMs: 20 * 60_000 })
    if (result.code !== 0) throw upFailure(result, [password, inbox.token, ...Object.values(approvedValues(deps))])
    const target = { baseUrl: `http://127.0.0.1:${port}`, password }
    await waitHealthy(deps, target, run.container)
    run.state.startedHere = true
    // R5-01: the data volume outlives the box, so every start (and every set change) cleans it.
    await pruneSignIns(run, plan)
    await sweepOutBundles(run)
    return target
  })
}

/** Docker up and the home folder there: the steps before the start lock. */
async function prepareHost(run: Run): Promise<void> {
  const { deps } = run
  await requireDocker(deps.exec)
  await mkdir(deps.config.home, { recursive: true }).catch((error: unknown) => {
    throw fsFailure("create the bridge home folder", error, deps.config.home)
  })
}

/** This bridge's plan (profile, policy, front config) for `keystone`, or for the saved / default set. */
async function plan(run: Run, keystone?: readonly string[]): Promise<Plan> {
  const made = await planFor(run.deps, keystone)
  if (made.built.dropped.length) run.note("warn", "providers left out of the box profile", { dropped: made.built.dropped.map((d) => d.provider).join(",") })
  return made
}

async function ensure(run: Run): Promise<ApiTarget> {
  await prepareHost(run)
  const made = await plan(run)
  return withStartLock(run.deps.leaseFs, run.dirs.startLock, async () => {
    const box = await inspectBox(run.deps.exec, INSPECT_ENV, run.container)
    return box?.running ? reuse(run, box, made) : start(run, made)
  }, await lockOptions(run))
}

/** `compose down` with the same -f files as `up`, from the bridge home (review N-1). Never -v. Caller holds the start lock. */
async function composeDown(run: Run): Promise<void> {
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
}

async function release(run: Run): Promise<void> {
  if (!run.state.leased) return run.note("info", "release: this bridge holds no lease; nothing to stop")
  await withStartLock(run.deps.leaseFs, run.dirs.startLock, async () => {
    // Waits for a heartbeat already in flight, so it cannot re-create the lease (review N-10).
    await run.stopHeartbeat()
    const remaining = await run.leases.release(run.deps.bridgeId)
    run.state.leased = false
    if (remaining > 0) return run.note("info", "lease released; sandbox kept", { remaining })
    await composeDown(run)
    run.note("info", "last lease released; sandbox stopped")
  }, await lockOptions(run))
}

function othersHold(others: number): DelegateError {
  return new DelegateError("profile_changed", "Other bridges are using the sandbox, so it was not restarted.", restartAction(others), `${others} other live lease(s)`)
}

/**
 * oc_server_restart (GAP-1): works even when ensure() fails with profile_changed, because it
 * needs no lease. Under the start lock, so no other bridge can start or reuse the box meanwhile:
 * refuse while other bridges hold a running box (unless force), else down + the normal start.
 * Other bridges' leases stay; their next ensure() reuses the new box or reports profile_changed.
 * `keystone` (R4-01) changes the box-wide set: the plan is built and checked first, the set is
 * saved only after the refusal check, so a refused restart changes nothing.
 */
async function replace(run: Run, options: ReplaceOptions): Promise<ReplaceResult> {
  await prepareHost(run)
  const made = await plan(run, options.keystone)
  return withStartLock(run.deps.leaseFs, run.dirs.startLock, async () => {
    const others = await otherLeases(run)
    const box = await inspectBox(run.deps.exec, [], run.container)
    const running = box?.running === true
    if (running && others > 0 && !options.force) throw othersHold(others)
    if (options.keystone) saveKeystoneSet(run.deps.config.home, made.config.keystoneConnections)
    run.note("info", "replacing sandbox", { running, others, force: options.force, keystone: made.config.keystoneConnections.join(","), keystoneSaved: options.keystone !== undefined })
    await composeDown(run)
    const target = await start(run, made)
    return { target, interrupted: running ? others : 0, keystone: made.config.keystoneConnections }
  }, await lockOptions(run))
}

export function createSupervisor(deps: SupervisorDeps): DelegateSupervisor {
  const ctx = createContext(deps)
  return {
    ensure: () => traced(ctx, "ensure", ensure),
    status: () => traced(ctx, "status", statusOf),
    verifyLive: () => traced(ctx, "verifyLive", verifyLive),
    release: () => traced(ctx, "release", release),
    replace: (options) => traced(ctx, "replace", (run) => replace(run, options)),
    login: (entry, opener) =>
      traced(ctx, "login", async () => {
        if (!deps.login) throw new DelegateError("upstream_error", "Sign-in is not wired into this bridge.", "Update the bridge.")
        return deps.login(entry, opener)
      }, "upstream_error"),
  }
}
