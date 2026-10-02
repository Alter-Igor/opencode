// MOD-04 wiring: builds the ToolContext the MCP server and the CLI use.
// Nothing here touches Docker until a tool asks: the supervisor deps (which read git for the image
// identity) are made on first use, and the box + event hub are started by the first box() call.
// Logs go to stderr and <home>/logs; stdout belongs to the MCP protocol (D-1).
import { randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createHub, type DelegateHub } from "./events/index.ts"
import { createGuard } from "./guard/index.ts"
import { cachedTarget, createInbox, inboxTargetFromDocker } from "./inbox/index.ts"
import { flushReports } from "./reporting/hooks.ts"
import { currentKeystone, defaultConfig, frontDir, type BridgeConfig } from "./shared/config.ts"
import { DelegateError } from "./shared/errors.ts"
import { createLogger, safeLog, type Logger } from "./shared/log.ts"
import { createApi, type ApiTarget, type OpencodeApi } from "./shared/opencode-api.ts"
import { containerName } from "./supervisor/compose-env.ts"
import { bunExec } from "./supervisor/docker.ts"
import { createSupervisor, defaultSupervisorDeps, type DelegateSupervisor, type ReplaceOptions } from "./supervisor/lifecycle.ts"
import { login } from "./supervisor/login.ts"
import { createWorkspaces } from "./supervisor/workspaces.ts"
import { createSynapseAuth, type SynapseAuth } from "./synapse/index.ts"
import { reloadFront } from "./synapse/token-manager.ts"
import { keystoneHostAuth } from "./guard/egress-identity.ts"
import { createKeystoneAuth, type KeystoneAuth } from "./keystone-auth/index.ts"
import { connectSignedIn, createKsPublisher, ensureEntryConnected, startReconnectLoop } from "./keystone-auth/host-wiring.ts"
import { cleanEnv, runCommand } from "./supervisor/workspaces-exec.ts"
import type { Box, CommandRunner, RestartedBox, SessionRecord, ToolContext } from "./tools/context.ts"

export const NAME_RE = /^[a-z0-9-]{1,40}$/
/** Re-run ensure() at most this often while a box is held (catches another bridge's restart). */
export const REVALIDATE_MS = 30_000
export const SHUTDOWN_MS = 15_000
const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
export const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..")

export function bridgeName(env: NodeJS.ProcessEnv): string {
  const name = env.OPENCODE_DELEGATE_NAME
  if (name === undefined || name === "") return `claude-${randomBytes(3).toString("hex")}`
  if (!NAME_RE.test(name)) throw new DelegateError("invalid_input", "OPENCODE_DELEGATE_NAME is not a valid bridge name.", "Use 1-40 characters: a-z, 0-9 and '-'.")
  return name
}

export type VersionInfo = { version: string; package: string; sha: string; dirty: boolean; built: string | null }

/** `<package>-dev+<sha>[.dirty]` for a source run (VER-DEV-01); dirty = uncommitted changes in this package. */
export async function readVersion(run: CommandRunner = hostRunner, env: NodeJS.ProcessEnv = process.env): Promise<VersionInfo> {
  let pkg = "0.0.0"
  try {
    pkg = String((JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8")) as { version?: unknown }).version ?? pkg)
  } catch {
    // reported as 0.0.0
  }
  const head = await run(["git", "-C", REPO_ROOT, "rev-parse", "--short=10", "HEAD"], 10_000)
  const sha = head.code === 0 && /^[0-9a-f]{7,40}$/.test(head.stdout.trim()) ? head.stdout.trim() : "unknown"
  const status = await run(["git", "-C", REPO_ROOT, "status", "--porcelain", "--", "alterspective/delegate-mcp"], 10_000)
  const dirty = status.code !== 0 || status.stdout.trim() !== ""
  return { version: `${pkg}-dev+${sha}${dirty ? ".dirty" : ""}`, package: pkg, sha, dirty, built: env.APP_BUILD_DATE ?? null }
}

const hostRunner: CommandRunner = (argv, timeoutMs) => runCommand(argv, cleanEnv(), timeoutMs)

export type BoxManager = {
  box(): Promise<Box>
  peek(): Box | undefined
  /** oc_server_restart: supervisor.replace(), single-flight with box() so no ensure runs alongside it. */
  restart(options?: ReplaceOptions): Promise<RestartedBox>
  onBox(listener: (box: Box) => void): () => void
  stop(): Promise<void>
}

export type BoxManagerDeps = {
  supervisor: Pick<DelegateSupervisor, "ensure" | "replace">
  sessions: Map<string, SessionRecord>
  log: Logger
  api?: (target: ApiTarget) => OpencodeApi
  hub?: (target: ApiTarget, api: OpencodeApi) => DelegateHub
  now?: () => number
  revalidateMs?: number
}

const sameTarget = (a: ApiTarget, b: ApiTarget) => a.baseUrl === b.baseUrl && a.password === b.password

/** Single-flight box(): one ensure() at a time; a new target gets a new api and hub (sessions re-tracked). */
export function createBoxManager(deps: BoxManagerDeps): BoxManager {
  return new Manager(deps)
}

class Manager implements BoxManager {
  private readonly listeners = new Set<(box: Box) => void>()
  private readonly now: () => number
  private current: Box | undefined
  private checkedAt = 0
  private pending: Promise<Box> | undefined

  constructor(private readonly deps: BoxManagerDeps) {
    this.now = deps.now ?? Date.now
  }

  box(): Promise<Box> {
    const fresh = this.now() - this.checkedAt < (this.deps.revalidateMs ?? REVALIDATE_MS)
    return this.current && !this.pending && fresh ? Promise.resolve(this.current) : this.ensure()
  }

  peek(): Box | undefined {
    return this.current
  }

  /** Becomes the pending call at once, so a box() made while the old hub stops waits for the new box. */
  async restart(options: ReplaceOptions = { force: false }): Promise<RestartedBox> {
    const prior = this.pending
    let interrupted = 0
    let keystone: string[] = []
    const target = (async () => {
      await prior?.catch(() => undefined)
      await this.stop().catch(() => undefined)
      const result = await this.deps.supervisor.replace(options)
      interrupted = result.interrupted
      keystone = result.keystone
      return result.target
    })()
    const box = await this.track(target)
    return { ...box, interrupted, keystone }
  }

  onBox(listener: (box: Box) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async stop(): Promise<void> {
    const box = this.current
    this.current = undefined
    await box?.hub.stop()
  }

  private ensure(): Promise<Box> {
    return this.pending ?? this.track(this.deps.supervisor.ensure())
  }

  /** Make `work` the one pending box call; concurrent box() calls share it. */
  private track(work: Promise<ApiTarget>): Promise<Box> {
    const pending: Promise<Box> = work
      .then(async (target) => {
        const box = await this.swap(target)
        this.checkedAt = this.now()
        return box
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined
      })
    this.pending = pending
    return pending
  }

  private async swap(target: ApiTarget): Promise<Box> {
    if (this.current && sameTarget(this.current.target, target)) return this.current
    // R3-09: let go of the old box before stopping it, so a new hub that fails to start never
    // leaves the stopped one handed out by box() or peek().
    const old = this.current
    this.current = undefined
    await old?.hub.stop().catch(() => undefined)
    const { deps } = this
    const api = (deps.api ?? ((t: ApiTarget) => createApi(t)))(target)
    const hub = (deps.hub ?? ((t: ApiTarget, a: OpencodeApi) => createHub({ target: t, api: a, log: deps.log })))(target, api)
    for (const s of deps.sessions.values()) hub.track(s.sessionID, s.boxPath)
    try {
      await hub.start()
    } catch (error) {
      await hub.stop().catch(() => undefined)
      throw error
    }
    const box: Box = { target, api, hub }
    this.current = box
    safeLog(deps.log, "info", "runtime", "box ready", { baseUrl: target.baseUrl, sessions: deps.sessions.size })
    this.notify(box)
    return box
  }

  private notify(box: Box): void {
    for (const listener of this.listeners) {
      try {
        listener(box)
      } catch (error) {
        safeLog(this.deps.log, "warn", "runtime", "box listener failed", { detail: String(error).slice(0, 200) })
      }
    }
  }
}

/** The supervisor, made on first use (its deps read git); release() before any use is a no-op. */
function lazySupervisor(make: () => Promise<DelegateSupervisor>): DelegateSupervisor {
  let made: Promise<DelegateSupervisor> | undefined
  const get = () => (made ??= make().catch((error: unknown) => {
    made = undefined
    throw error
  }))
  return {
    ensure: async () => (await get()).ensure(),
    status: async () => (await get()).status(),
    verifyLive: async () => (await get()).verifyLive(),
    release: async () => (made ? (await made).release() : undefined),
    replace: async (options) => (await get()).replace(options),
    login: async (entry, opener) => (await get()).login(entry, opener),
  }
}

/** `keystone` is present only with OCD_KEYSTONE_HOST_AUTH=1 (#67 step 4): start() runs its renewal loop. */
export type Runtime = { ctx: ToolContext; versionInfo: VersionInfo; name: string; synapse?: Pick<SynapseAuth, "start">; keystone?: { start(): () => void }; shutdown(reason: string): Promise<void> }

export type RuntimeOptions = { env?: NodeJS.ProcessEnv; config?: BridgeConfig; log?: Logger; version?: VersionInfo }

function logger(config: BridgeConfig, env: NodeJS.ProcessEnv): Logger {
  const level = env.OPENCODE_DELEGATE_LOG_LEVEL
  const minLevel = level === "debug" || level === "warn" || level === "error" ? level : "info"
  return createLogger({ dir: path.join(config.home, "logs"), minLevel })
}

function supervisorFor(config: BridgeConfig, bridgeId: string, log: Logger, box: () => Promise<Box>): DelegateSupervisor {
  const guard = createGuard(config)
  return lazySupervisor(async () =>
    createSupervisor(
      await defaultSupervisorDeps(config, {
        bridgeId,
        permission: guard.permissionBaseline("standard"),
        repoRoot: REPO_ROOT,
        log,
        login: async (entry, opener) => login((await box()).api, entry, { authOrigin: config.keystoneOrigin, logger: log, opener }),
      }),
    ),
  )
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const env = options.env ?? process.env
  const config = options.config ?? defaultConfig(env)
  const name = bridgeName(env)
  const bridgeId = `${name}-${process.pid}-${randomBytes(3).toString("hex")}`
  const log = options.log ?? logger(config, env)
  const versionInfo = options.version ?? (await readVersion(hostRunner, env))
  const sessions = new Map<string, SessionRecord>()
  const supervisorService = supervisorFor(config, bridgeId, log, () => manager.box())
  const manager = createBoxManager({ supervisor: supervisorService, sessions, log })
  const inboxTarget = cachedTarget(() => inboxTargetFromDocker(bunExec, config))
  const container = containerName(config)
  const synapse = createSynapseAuth(config, env, log)
  // The same source as the profile, guard, front generator and supervisor (process.env).
  const keystone = keystoneHostAuth() ? hostKeystone(config, env, log, synapse, () => manager.peek()) : undefined
  // A renewal while this bridge held no box connected nothing: connect signed-in entries on each new box.
  if (keystone) manager.onBox((box) => void connectSignedIn((ids) => keystone.status(ids), currentKeystone(config).connections, box.api, log))
  const ctx: ToolContext = {
    config,
    supervisor: `supervisor:${name}`,
    bridgeId,
    version: versionInfo.version,
    log,
    guard: createGuard(config),
    supervisorService,
    workspaces: createWorkspaces({ config, container, logger: log }),
    inbox: createInbox({ supervisor: `supervisor:${name}`, target: inboxTarget.target, invalidate: inboxTarget.invalidate }),
    box: () => manager.box(),
    peekBox: () => manager.peek(),
    apiFor: (target) => createApi(target),
    restartBox: async (options) => {
      inboxTarget.invalidate()
      return manager.restart(options)
    },
    onBox: (listener) => manager.onBox(listener),
    boxExec: (argv, timeoutMs) => runCommand(["docker", "exec", container, ...argv], cleanEnv(), timeoutMs ?? 60_000),
    hostExec: (argv, timeoutMs) => hostRunner(argv, timeoutMs ?? 60_000),
    sessions,
    synapse,
    ...(keystone ? { keystone } : {}),
    correlationId: () => randomUUID(),
  }
  log.log("info", "runtime", "bridge created", { bridge: name, bridgeId, version: versionInfo.version, roots: config.roots.length, keystoneHostAuth: keystone !== undefined })
  return {
    ctx,
    versionInfo,
    name,
    synapse,
    // The renewal loop reads the chosen set on every tick (a set change needs no restart of the loop).
    // The reconnect loop: each bridge reconnects signed-in entries on the box IT holds, so a token
    // renewed by another bridge sharing the box still gets its entries connected here.
    ...(keystone ? { keystone: { start: () => startHostKeystone(keystone, config, log, () => manager.peek()?.api) } } : {}),
    shutdown: shutdownOnce(manager, supervisorService, log),
  }
}

/** Start the renewal loop and the reconnect loop; the returned function stops both. */
function startHostKeystone(keystone: KeystoneAuth, config: BridgeConfig, log: Logger, heldApi: () => OpencodeApi | undefined): () => void {
  const ids = () => currentKeystone(config).connections
  const stopRenewal = keystone.start(ids)
  const stopReconnect = startReconnectLoop(heldApi, (chosen) => keystone.status(chosen), ids, log)
  return () => {
    stopReconnect()
    stopRenewal()
  }
}

/**
 * #67 step 4: the host Keystone token manager, publishing through front. `publish` runs while the
 * manager holds the shared lock (synapse/lock.ts), so it writes the include and reloads front with
 * the Synapse reload, which never takes that lock (it is not re-entrant). The box entry is then
 * connected on the box this bridge already holds; the box is never started for it.
 */
export function hostKeystone(config: BridgeConfig, env: NodeJS.ProcessEnv, log: Logger, synapse: Pick<SynapseAuth, "deps">, heldBox: () => Box | undefined): KeystoneAuth {
  const publish = createKsPublisher({
    frontDir: frontDir(config),
    reload: () => reloadFront(synapse.deps, { record: false, component: "keystone-auth" }),
    connect: async (entry) => {
      const box = heldBox()
      return box ? ensureEntryConnected(box.api, entry, log) : "not_running"
    },
    log,
  })
  return createKeystoneAuth(config, env, log, publish)
}

/**
 * One shutdown per process: stop the hub, release the lease. Capped at `capMs` so a hung Docker
 * call cannot keep the process alive after the MCP client went away (W3A-20 covers the cap).
 */
export function shutdownOnce(manager: Pick<BoxManager, "stop">, supervisor: Pick<DelegateSupervisor, "release">, log: Logger, capMs = SHUTDOWN_MS): (reason: string) => Promise<void> {
  let done: Promise<void> | undefined
  return (reason) =>
    (done ??= (async () => {
      safeLog(log, "info", "runtime", "shutting down", { reason })
      const work = (async () => {
        // #73: queued task record updates first; inside the time cap like everything else here.
        await flushReports().catch(() => undefined)
        await manager.stop().catch(() => undefined)
        await supervisor.release().catch((error: unknown) => safeLog(log, "warn", "runtime", "release on shutdown failed", { detail: String(error).slice(0, 200) }))
      })()
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<void>((resolve) => (timer = setTimeout(resolve, capMs)))
      await Promise.race([work, deadline])
      if (timer) clearTimeout(timer)
    })())
}

export type ProcessLike = {
  stdin: { once(event: "end" | "close", listener: () => void): unknown }
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown
}

/** Resolves (with the reason) on stdin end/close, SIGINT or SIGTERM: the MCP client went away. */
export function shutdownSignal(proc: ProcessLike): Promise<string> {
  return new Promise((resolve) => {
    proc.stdin.once("end", () => resolve("stdin ended"))
    proc.stdin.once("close", () => resolve("stdin closed"))
    proc.once("SIGINT", () => resolve("SIGINT"))
    proc.once("SIGTERM", () => resolve("SIGTERM"))
  })
}
