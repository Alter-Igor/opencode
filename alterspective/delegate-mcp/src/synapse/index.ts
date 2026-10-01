// WS2 (#48): wiring for the host-held Synapse token (token-manager.ts) and its oc_doctor report.
import path from "node:path"
import { readFile } from "node:fs/promises"
import { frontDir, type BridgeConfig } from "../shared/config.ts"
import type { Logger } from "../shared/log.ts"
import { bunExec, type Exec } from "../supervisor/docker.ts"
import { nodeLeaseFs } from "../supervisor/leases.ts"
import { defaultOpener } from "../supervisor/login.ts"
import { nodeProcessProbe, ownStartTime } from "../supervisor/process.ts"
import { withStartLock } from "../supervisor/start-lock.ts"
import { AUTH_FILE_NAME, authConfHasToken, authConfPath, isAuthConf } from "./auth-conf.ts"
import { loadAppSecrets, type AppSecrets } from "./secrets.ts"
import { dpapiStore, refreshStoreFile } from "./secret-store.ts"
import { DEFAULT_REFRESH_FRACTION, readState, refreshAt, refreshIfDue, signIn, startRefreshLoop, type SynapseDeps } from "./token-manager.ts"

export const REFRESH_FRACTION_ENV = "OPENCODE_DELEGATE_SYNAPSE_REFRESH_FRACTION"
const LOCK_WAIT_MS = 2 * 60_000

/** 0.01-0.95; anything else is the default 0.8 (the env exists so a live test can force a refresh). */
export function refreshFraction(env: NodeJS.ProcessEnv): number {
  const value = Number(env[REFRESH_FRACTION_ENV])
  return Number.isFinite(value) && value >= 0.01 && value <= 0.95 ? value : DEFAULT_REFRESH_FRACTION
}

export type SynapseAuth = {
  deps: SynapseDeps
  signIn(opener?: (url: string) => void): ReturnType<typeof signIn>
  refresh(force?: boolean): ReturnType<typeof refreshIfDue>
  status(exec?: Exec): Promise<SynapseReport>
  start(): () => void
}

export function createSynapseAuth(config: Pick<BridgeConfig, "home" | "keystoneOrigin" | "project">, env: NodeJS.ProcessEnv, log: Logger): SynapseAuth {
  let secrets: Promise<AppSecrets> | undefined
  const loadSecrets = () => (secrets ??= loadAppSecrets(env).then((loaded) => loaded.secrets).catch((error: unknown) => {
    secrets = undefined
    throw error
  }))
  const lockFile = path.join(config.home, "synapse", "refresh.lock")
  const deps: SynapseDeps = {
    home: config.home,
    frontDir: frontDir(config),
    origin: config.keystoneOrigin,
    frontContainer: `${config.project}-front`,
    store: dpapiStore(refreshStoreFile(config.home)),
    secrets: loadSecrets,
    fetch: (input, init) => fetch(input, init),
    exec: bunExec,
    lock: async (fn) => withStartLock(nodeLeaseFs, lockFile, fn, { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), probe: nodeProcessProbe, self: { pid: process.pid, startedAt: await ownStartTime(nodeProcessProbe) }, waitMs: LOCK_WAIT_MS, staleMs: LOCK_WAIT_MS }),
    now: Date.now,
    refreshFraction: refreshFraction(env),
    opener: defaultOpener,
    log,
  }
  return {
    deps,
    signIn: (opener) => signIn(opener ? { ...deps, opener } : deps),
    refresh: (force) => refreshIfDue(deps, force),
    status: (exec) => synapseReport(deps, exec ?? deps.exec),
    start: () => startRefreshLoop(deps),
  }
}

export type SynapseReport = {
  /** signed_in: a live token is in front's include; needs_sign_in: run oc_login {server:"synapse"}. */
  state: "signed_in" | "needs_sign_in" | "expired"
  user?: string
  actor?: string
  expiresAt?: string
  refreshAt?: string
  refreshTokenStored: boolean
  store: string
  lastError?: string
  /** The include on the host: well-formed and carrying a token (never the token). */
  hostFile: { shapeOk: boolean; hasToken: boolean }
  /** What front has LOADED (`nginx -T`): the include is the strict one-variable shape. */
  live: { shapeOk: boolean; hasToken: boolean } | { unavailable: string }
  ok: boolean
}

export async function synapseReport(deps: SynapseDeps, exec: Exec): Promise<SynapseReport> {
  const state = await readState(deps.home)
  const conf = await readFile(authConfPath(deps.frontDir), "utf8").catch(() => "")
  const stored = await deps.store.has()
  const hostFile = { shapeOk: isAuthConf(conf), hasToken: authConfHasToken(conf) }
  const expired = state !== undefined && deps.now() >= state.expiresAt
  const kind = !state || state.needsSignIn || !stored || !hostFile.hasToken ? "needs_sign_in" : expired ? "expired" : "signed_in"
  const live = await liveAuth(exec, deps.frontContainer)
  const liveOk = !("unavailable" in live) && live.shapeOk && live.hasToken
  return {
    state: kind,
    ...(state?.user ? { user: state.user } : {}),
    ...(state?.actor ? { actor: state.actor } : {}),
    ...(state && state.expiresAt > 0 ? { expiresAt: new Date(state.expiresAt).toISOString(), refreshAt: new Date(refreshAt(state, deps.refreshFraction)).toISOString() } : {}),
    refreshTokenStored: stored,
    store: deps.store.kind,
    ...(state?.lastError ? { lastError: state.lastError } : {}),
    hostFile,
    live,
    ok: kind === "signed_in" && hostFile.shapeOk && liveOk,
  }
}

const LIVE_HEADER = `# configuration file /etc/nginx/front-gen/${AUTH_FILE_NAME}:\n`

/** The include as front loaded it, checked against the strict shape. The text never leaves this function. */
export async function liveAuth(exec: Exec, container: string): Promise<SynapseReport["live"]> {
  const dump = await exec(["docker", "exec", container, "nginx", "-T"], { timeoutMs: 20_000 })
  if (dump.code !== 0) return { unavailable: "front is not running, or `nginx -T` failed" }
  const text = dump.stdout.replaceAll("\r\n", "\n")
  const at = text.indexOf(LIVE_HEADER)
  if (at === -1) return { unavailable: `front has not loaded ${AUTH_FILE_NAME}` }
  const start = at + LIVE_HEADER.length
  const next = text.indexOf("\n# configuration file ", start)
  const section = next === -1 ? text.slice(start).replace(/\n$/, "") : text.slice(start, next)
  return { shapeOk: isAuthConf(section), hasToken: authConfHasToken(section) }
}
