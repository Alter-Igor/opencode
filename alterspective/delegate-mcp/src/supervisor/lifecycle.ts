// MOD-01 T1.3: Supervisor.ensure/status/release (contracts.ts, technical-design.md §4).
// The server password lives only in this process's memory and in the env of the
// `docker compose` child (and so the container). It is never written to a file or logged.
import { randomBytes } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { mcpAllowPolicy, type BridgeConfig } from "../shared/config.ts"
import type { BoxState, Supervisor } from "../shared/contracts.ts"
import { DelegateError } from "../shared/errors.ts"
import { silentLogger, type Logger } from "../shared/log.ts"
import type { ApiTarget } from "../shared/opencode-api.ts"
import {
  BOX_CONTAINER, LABEL, bunExec, childEnv, dockerArgs, freePort, imageExists, imageTag, inspectBox, requireDocker,
  type BoxInspect, type Exec,
} from "./docker.ts"
import { createLeases, nodeLeaseFs, processAlive, withStartLock, type LeaseFs, type Leases } from "./leases.ts"
import { buildProfile, nodeProfileFs, readOwnerConfigs, writeProfile, type BuiltProfile, type PermissionRule, type ProfileFs } from "./profile.ts"

export const PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD"
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type SupervisorDeps = {
  config: BridgeConfig
  bridgeId: string
  pid: number
  /** Full image reference, e.g. opencode-delegate-box:1.18.31-1483a47. */
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
  isAlive: (pid: number) => boolean
  fetch: typeof fetch
  freePort: () => Promise<number>
  randomPassword: () => string
  sleep: (ms: number) => Promise<void>
  now: () => number
  healthTimeoutMs?: number
  login?: Supervisor["login"]
  log?: Logger
}

export function paths(config: BridgeConfig) {
  return {
    profile: path.join(config.home, "profile"),
    handoff: path.join(config.home, "handoff"),
    leases: path.join(config.home, "leases"),
    startLock: path.join(config.home, "start.lock"),
    boxEnvOverride: path.join(config.home, "compose.box-env.yaml"),
  }
}

/** Compose override listing the approved box env vars by NAME only (values come from the child env). */
export function boxEnvOverride(names: string[]): string {
  for (const name of names) if (!ENV_NAME.test(name)) throw new Error("invalid box env name")
  if (names.length === 0) return "services: {}\n"
  return ["services:", "  box:", "    environment:", ...names.map((name) => `      ${name}:`)].join("\n") + "\n"
}

/** Env of the `docker compose up` child: CLI essentials + OCD_* + password + approved keys. */
export function composeEnv(deps: SupervisorDeps, built: BuiltProfile, port: number, password: string): Record<string, string> {
  const dirs = paths(deps.config)
  const approved: Record<string, string> = {}
  for (const name of deps.config.boxEnv) {
    const value = deps.hostEnv[name]
    if (value !== undefined) approved[name] = value
  }
  return childEnv(deps.hostEnv, {
    ...approved,
    OCD_IMAGE: deps.image,
    OCD_OPENCODE_VERSION: deps.opencodeVersion,
    OCD_PROFILE_HASH: built.hash,
    OCD_PORT: String(port),
    OCD_PROFILE_DIR: dirs.profile,
    OCD_HANDOFF_DIR: dirs.handoff,
    OPENCODE_MCP_ALLOW: mcpAllowPolicy(deps.config),
    [PASSWORD_ENV]: password,
  })
}

type Ctx = {
  deps: SupervisorDeps
  log: Logger
  dirs: ReturnType<typeof paths>
  leases: Leases
  compose: { project: string; files: string[] }
  state: { startedHere: boolean }
}

async function currentProfile(ctx: Ctx): Promise<BuiltProfile> {
  const { deps } = ctx
  const ownerConfigs = await readOwnerConfigs(deps.profileFs, deps.ownerConfigDir)
  return buildProfile({ ownerConfigs, config: deps.config, permission: deps.permission, keyEnv: deps.keyEnv })
}

async function waitHealthy(deps: SupervisorDeps, target: ApiTarget): Promise<void> {
  const deadline = deps.now() + (deps.healthTimeoutMs ?? 120_000)
  const auth = "Basic " + Buffer.from(`opencode:${target.password}`).toString("base64")
  while (deps.now() < deadline) {
    const status = await deps
      // Per-probe timeout: Docker Desktop can accept on the published port before the gate is
      // wired and then hold the connection open (observed live), so one probe must never hang.
      .fetch(`${target.baseUrl}/path?directory=/sessions`, { headers: { authorization: auth }, signal: AbortSignal.timeout(3000) })
      .then((res) => res.status, () => 0)
    if (status === 200) return
    await deps.sleep(1000)
  }
  throw new DelegateError("server_down", "The sandbox started but OpenCode did not become healthy in time.", "Run oc_doctor; check `docker logs opencode-delegate`.")
}

function targetOf(box: BoxInspect): ApiTarget {
  const password = box.env[PASSWORD_ENV]
  const port = Number(box.labels[LABEL.port])
  if (!password || !Number.isInteger(port) || port <= 0)
    throw new DelegateError("server_down", "The running sandbox is missing its bridge settings.", "Stop it with `docker compose -p opencode-delegate down` and retry.")
  return { baseUrl: `http://127.0.0.1:${port}`, password }
}

async function reuse(ctx: Ctx, box: BoxInspect, hash: string): Promise<ApiTarget> {
  if (box.labels[LABEL.profileHash] !== hash)
    throw new DelegateError(
      "profile_changed",
      "The running sandbox uses an older profile (config, model list or permissions changed).",
      "Close the other bridges (or run `docker compose -p opencode-delegate down`) so the sandbox restarts with the new profile.",
    )
  const target = targetOf(box)
  await waitHealthy(ctx.deps, target)
  await ctx.leases.acquire(ctx.deps.bridgeId, ctx.deps.pid)
  return target
}

async function start(ctx: Ctx, built: BuiltProfile): Promise<ApiTarget> {
  const { deps, dirs } = ctx
  const onDisk = await writeProfile(deps.profileFs, dirs.profile, built.files)
  if (onDisk !== built.hash) throw new DelegateError("profile_invalid", "The profile on disk does not match what was built.", "Retry; check that nothing else writes the profile folder.")
  await mkdir(dirs.handoff, { recursive: true })
  await writeFile(dirs.boxEnvOverride, boxEnvOverride(deps.config.boxEnv), "utf8")
  const password = deps.randomPassword()
  const port = await deps.freePort()
  const build = !(await imageExists(deps.exec, deps.image))
  ctx.log.log("info", "supervisor", "starting sandbox", { image: deps.image, build, port, profileHash: built.hash })
  const result = await deps.exec(dockerArgs.up(ctx.compose, build), { env: composeEnv(deps, built, port, password), timeoutMs: 20 * 60_000 })
  if (result.code !== 0)
    throw new DelegateError("server_down", "The sandbox failed to start.", "Run oc_doctor; check Docker Desktop.", result.stderr.split(password).join("[redacted]").slice(-600))
  const target = { baseUrl: `http://127.0.0.1:${port}`, password }
  await waitHealthy(deps, target)
  await ctx.leases.acquire(deps.bridgeId, deps.pid)
  ctx.state.startedHere = true
  return target
}

async function ensure(ctx: Ctx): Promise<ApiTarget> {
  const { deps } = ctx
  await requireDocker(deps.exec)
  const built = await currentProfile(ctx)
  const box = await inspectBox(deps.exec, [PASSWORD_ENV])
  if (box?.running) return reuse(ctx, box, built.hash)
  await mkdir(deps.config.home, { recursive: true })
  return withStartLock(deps.leaseFs, ctx.dirs.startLock, async () => {
    const again = await inspectBox(deps.exec, [PASSWORD_ENV])
    return again?.running ? reuse(ctx, again, built.hash) : start(ctx, built)
  }, { now: deps.now, sleep: deps.sleep })
}

async function status(ctx: Ctx): Promise<BoxState> {
  try {
    await requireDocker(ctx.deps.exec)
  } catch (error) {
    return { state: "unavailable", reason: error instanceof DelegateError ? error.message : "Docker is not available." }
  }
  const box = await inspectBox(ctx.deps.exec, [PASSWORD_ENV])
  if (!box?.running) return { state: "stopped" }
  return { state: "running", target: targetOf(box), imageTag: box.image, startedBy: ctx.state.startedHere ? "this-bridge" : "other" }
}

async function release(ctx: Ctx): Promise<void> {
  const remaining = await ctx.leases.release(ctx.deps.bridgeId)
  if (remaining > 0) return ctx.log.log("info", "supervisor", "lease released; sandbox kept", { remaining })
  const result = await ctx.deps.exec(dockerArgs.down(ctx.deps.config.project), { timeoutMs: 120_000 })
  ctx.log.log(result.code === 0 ? "info" : "warn", "supervisor", "last lease released; sandbox stopped", { code: result.code })
  ctx.state.startedHere = false
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const dirs = paths(deps.config)
  const ctx: Ctx = {
    deps,
    log: deps.log ?? silentLogger,
    dirs,
    leases: createLeases(deps.leaseFs, dirs.leases, deps.isAlive),
    compose: { project: deps.config.project, files: [deps.composeFile, dirs.boxEnvOverride] },
    state: { startedHere: false },
  }
  return {
    ensure: () => ensure(ctx),
    status: () => status(ctx),
    release: () => release(ctx),
    async login(entry, opener) {
      if (!deps.login) throw new DelegateError("upstream_error", "Sign-in is not wired into this bridge.", "Update the bridge.")
      return deps.login(entry, opener)
    },
  }
}

/** Production wiring: real docker CLI, real files, owner config from ~/.config/opencode. */
export async function defaultSupervisorDeps(
  config: BridgeConfig,
  options: { bridgeId: string; permission: PermissionRule[]; repoRoot: string; log?: Logger; login?: Supervisor["login"] },
): Promise<SupervisorDeps> {
  const pkg = (await Bun.file(path.join(options.repoRoot, "packages", "opencode", "package.json")).json()) as { version: string }
  const sha = (await bunExec(["git", "-C", options.repoRoot, "rev-parse", "--short=7", "HEAD"])).stdout.trim()
  return {
    config,
    bridgeId: options.bridgeId,
    pid: process.pid,
    image: imageTag(config.image, pkg.version, sha),
    opencodeVersion: `${pkg.version}-alterspective.${sha}`,
    composeFile: path.join(options.repoRoot, "alterspective", "delegate-mcp", "docker", "compose.yaml"),
    ownerConfigDir: path.join(os.homedir(), ".config", "opencode"),
    permission: options.permission,
    keyEnv: { synapse: "SYNAPSE_API_KEY" },
    hostEnv: process.env,
    exec: bunExec,
    profileFs: nodeProfileFs,
    leaseFs: nodeLeaseFs,
    isAlive: processAlive,
    fetch,
    freePort,
    randomPassword: () => randomBytes(24).toString("base64url"),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    log: options.log,
    login: options.login,
  }
}

export { BOX_CONTAINER }
