// WS2 (#48): wiring for the host-held Synapse token (token-manager.ts) and its oc_doctor report.
import path from "node:path"
import { frontDir, type BridgeConfig } from "../shared/config.ts"
import type { Logger } from "../shared/log.ts"
import { bunExec, type Exec } from "../supervisor/docker.ts"
import { nodeLeaseFs } from "../supervisor/leases.ts"
import { defaultOpener } from "../supervisor/login.ts"
import { nodeProcessProbe, ownStartTime } from "../supervisor/process.ts"
import { withStartLock } from "../supervisor/start-lock.ts"
import { refreshIfDue, startRefreshLoop } from "./refresh.ts"
import { loadAppSecrets, type AppSecrets } from "./secrets.ts"
import { dpapiStore, refreshStoreFile } from "./secret-store.ts"
import { synapseReport, type SynapseReport } from "./report.ts"
import { DEFAULT_REFRESH_FRACTION, signIn, type SynapseDeps } from "./token-manager.ts"

export { liveAuth, synapseReport, type SynapseReport } from "./report.ts"

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
    memory: {},
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

