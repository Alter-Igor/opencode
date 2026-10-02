// #67 step 1: production wiring of the host Keystone token manager (manager.ts). Not wired into the
// bridge yet: WS-C calls createKeystoneAuth with the front writer WS-A2 provides as `publish`.
// The lock is the SAME file and options as the Synapse refresh (synapse/index.ts), so every write
// of front's files across bridges sharing one home happens under one lock.
import { randomUUID } from "node:crypto"
import type { BridgeConfig } from "../shared/config.ts"
import type { Logger } from "../shared/log.ts"
import { nodeLeaseFs } from "../supervisor/leases.ts"
import { LOGIN_PORT, LOGIN_TIMEOUT_MS, defaultOpener } from "../supervisor/login.ts"
import { nodeProcessProbe, ownStartTime } from "../supervisor/process.ts"
import { withStartLock } from "../supervisor/start-lock.ts"
import { SYNAPSE_LOCK_WAIT_MS, synapseLockFile } from "../synapse/lock.ts"
import { DEFAULT_REFRESH_FRACTION } from "../synapse/token-manager.ts"
import { refreshConnection, refreshDue, signIn, startKeystoneRefreshLoop, type KeystoneAuthDeps, type KsRefreshed, type KsSignIn, type Publish } from "./manager.ts"
import { keystoneAuthStatus, type KsStatus } from "./report.ts"
import { keystoneDpapiStore } from "./store.ts"

export type { KeystoneAuthDeps, KsRefreshed, KsSignIn, Publish } from "./manager.ts"
export type { KsStatus } from "./report.ts"

export const KEYSTONE_REFRESH_FRACTION_ENV = "OPENCODE_DELEGATE_KEYSTONE_REFRESH_FRACTION"

/**
 * 0.01-0.95; anything else is the Synapse default 0.8. The env exists so a live check can force an
 * early refresh (plan observation method: `...REFRESH_FRACTION=0.05`).
 *
 * @param env process environment
 * @returns the refresh fraction
 * @throws never
 * @example keystoneRefreshFraction({ OPENCODE_DELEGATE_KEYSTONE_REFRESH_FRACTION: "0.05" }) // 0.05
 */
export function keystoneRefreshFraction(env: NodeJS.ProcessEnv): number {
  const value = Number(env[KEYSTONE_REFRESH_FRACTION_ENV])
  return Number.isFinite(value) && value >= 0.01 && value <= 0.95 ? value : DEFAULT_REFRESH_FRACTION
}

export type KeystoneAuth = {
  deps: KeystoneAuthDeps
  signIn(connectionId: string, opener?: (url: string) => void): Promise<KsSignIn>
  refresh(connectionId: string, force?: boolean): Promise<KsRefreshed>
  refreshDue(connectionIds?: readonly string[]): Promise<KsRefreshed[]>
  status(connectionIds?: readonly string[]): Promise<KsStatus[]>
  /** Starts the renewal loop; `connectionIds` is read on every tick. Returns a stop function. */
  start(connectionIds?: () => readonly string[] | undefined): () => void
}

/**
 * Build the host Keystone token manager for one bridge.
 *
 * @param config bridge home and Keystone origin
 * @param env process environment (refresh fraction override)
 * @param log bridge logger
 * @param publish writes one connection's credential into front (WS-A2), called under the lock
 * @returns the manager
 * @throws never (failures surface from its calls)
 * @example const ks = createKeystoneAuth(config, process.env, log, publishKsAuth); const stop = ks.start(() => profile.connections)
 */
export function createKeystoneAuth(config: Pick<BridgeConfig, "home" | "keystoneOrigin">, env: NodeJS.ProcessEnv, log: Logger, publish: Publish): KeystoneAuth {
  const lockFile = synapseLockFile(config.home)
  let startedAt: Promise<number> | undefined
  const deps: KeystoneAuthDeps = {
    home: config.home,
    origin: config.keystoneOrigin,
    store: (id) => keystoneDpapiStore(config.home, id),
    memory: { id: `${process.pid}-${randomUUID()}`, held: new Map() },
    fetch: (url, init) => fetch(url, init),
    // Same lock as synapse/index.ts; this process's start time is read once, not per tick.
    lock: async (fn) => withStartLock(nodeLeaseFs, lockFile, fn, { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), probe: nodeProcessProbe, self: { pid: process.pid, startedAt: await (startedAt ??= ownStartTime(nodeProcessProbe)) }, waitMs: SYNAPSE_LOCK_WAIT_MS, staleMs: SYNAPSE_LOCK_WAIT_MS }),
    publish,
    now: Date.now,
    refreshFraction: keystoneRefreshFraction(env),
    opener: defaultOpener,
    loginPort: LOGIN_PORT,
    loginTimeoutMs: LOGIN_TIMEOUT_MS,
    log,
    probe: nodeProcessProbe,
    self: async () => ({ pid: process.pid, startedAt: await (startedAt ??= ownStartTime(nodeProcessProbe)) }),
  }
  return {
    deps,
    signIn: (id, opener) => signIn(opener ? { ...deps, opener } : deps, id),
    refresh: (id, force) => refreshConnection(deps, id, force),
    refreshDue: (ids) => refreshDue(deps, ids),
    status: (ids) => keystoneAuthStatus(deps, ids),
    start: (ids) => startKeystoneRefreshLoop(deps, ids),
  }
}
