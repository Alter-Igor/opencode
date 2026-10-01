// WS2 (#48): the owner's delegated Synapse token, kept and renewed on the HOST.
// - Sign-in (oc_login {server:"synapse"} / `opencode-delegate login synapse`): handoff → exchange
//   (offline) → access token into front's include, refresh token into the secret store, reload.
// - Renewal (refresh.ts): every bridge ticks; past `refreshFraction` of the token's life (0.8), one
//   bridge at a time (a lock in the bridge home) refreshes, writes the include and reloads front.
// - Two kinds of failure (review M2):
//   - Keystone REFUSED the refresh, or no refresh token is stored: "needs sign-in" (failClosed).
//   - Anything passing (Keystone down, a store read error): keep retrying with backoff. The token
//     stays in front until it expires; then the include is emptied (no credential leaves front)
//     but the bridge keeps retrying, and front gets a token again as soon as a refresh works.
// - A refresh token that could not be saved stays in memory and is saved on later ticks (M1).
// State on disk (<home>/synapse/state.json) holds times and the owner's id claims, never a token.
// Every write of the include or the state happens under the lock (review L1).
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { DelegateError } from "../shared/errors.ts"
import { safeLog, type Logger } from "../shared/log.ts"
import type { Exec } from "../supervisor/docker.ts"
import { writeAuthConf } from "./auth-conf.ts"
import { catchHandoff } from "./handoff-login.ts"
import { exchangeHandoff, jwtClaims, type Fetch, type TokenSet } from "./keystone-token.ts"
import type { AppSecrets } from "./secrets.ts"
import type { SecretStore } from "./secret-store.ts"

export const DEFAULT_REFRESH_FRACTION = 0.8
export const TICK_MS = 15_000

export type TokenState = {
  obtainedAt: number
  expiresAt: number
  user?: string
  actor?: string
  lastError?: string
  /** Keystone refused, or nothing is stored: only a new sign-in helps. */
  needsSignIn?: boolean
  /** Passing failures in a row, and when the next attempt may run (backoff). */
  failures?: number
  retryAt?: number
}
export type Reload = "reloaded" | "front_not_running" | "config_invalid"
export type Refreshed = { outcome: "fresh" | "refreshed" | "retrying" | "expired" | "failed_closed"; reload?: Reload; error?: string }

export type SynapseDeps = {
  home: string
  frontDir: string
  origin: string
  frontContainer: string
  store: SecretStore
  /** A rotated refresh token the store could not save yet (this bridge only, never on disk unencrypted). */
  memory: { pendingRefresh?: string }
  secrets: () => Promise<AppSecrets>
  fetch: Fetch
  exec: Exec
  /** Runs `fn` while holding the machine-wide refresh lock of this bridge home. */
  lock: <T>(fn: () => Promise<T>) => Promise<T>
  now: () => number
  refreshFraction: number
  opener: (url: string) => void
  log: Logger
}

export const stateFile = (home: string) => path.join(home, "synapse", "state.json")

export async function readState(home: string): Promise<TokenState | undefined> {
  const text = await readFile(stateFile(home), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as Partial<TokenState>
    return typeof value.obtainedAt === "number" && typeof value.expiresAt === "number" ? (value as TokenState) : undefined
  } catch {
    return undefined
  }
}

export async function writeState(home: string, state: TokenState): Promise<void> {
  const file = stateFile(home)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 })
  await rename(tmp, file)
}

/** When a refresh is due: `fraction` of the way through the token's lifetime. */
export const refreshAt = (state: Pick<TokenState, "obtainedAt" | "expiresAt">, fraction: number) => state.obtainedAt + Math.floor((state.expiresAt - state.obtainedAt) * fraction)

/** Due: past the renewal point and the backoff, and not waiting for a sign-in. */
export const isDue = (state: TokenState | undefined, now: number, fraction: number) =>
  state !== undefined && !state.needsSignIn && now >= Math.max(refreshAt(state, fraction), state.retryAt ?? 0)

/** Check, then reload. A config nginx refuses is never loaded (front keeps the last good one). */
export async function reloadFront(exec: Exec, container: string): Promise<Reload> {
  const test = await exec(["docker", "exec", container, "nginx", "-t", "-q"], { timeoutMs: 20_000 })
  if (test.code !== 0) {
    const running = await exec(["docker", "inspect", "--type", "container", "--format", "{{.State.Running}}", container], { timeoutMs: 20_000 })
    return running.code === 0 && running.stdout.trim() === "true" ? "config_invalid" : "front_not_running"
  }
  const reload = await exec(["docker", "exec", container, "nginx", "-s", "reload"], { timeoutMs: 20_000 })
  return reload.code === 0 ? "reloaded" : "config_invalid"
}

/**
 * Take a fresh token set (call under the lock): access token to front and state first, so a store
 * failure can never throw the new tokens away (M1); then the refresh token to the store, or to
 * memory when the store fails (saved on a later tick).
 */
export async function adopt(deps: SynapseDeps, tokens: TokenSet): Promise<Reload> {
  await writeAuthConf(deps.frontDir, tokens.accessToken)
  const claims = jwtClaims(tokens.accessToken) ?? {}
  const act = claims.act && typeof claims.act === "object" ? (claims.act as Record<string, unknown>).sub : undefined
  const user = typeof claims.email === "string" ? claims.email : typeof claims.sub === "string" ? claims.sub : undefined
  const now = deps.now()
  const state: TokenState = { obtainedAt: now, expiresAt: now + tokens.expiresInSec * 1000, ...(user ? { user } : {}), ...(typeof act === "string" ? { actor: act } : {}) }
  await writeState(deps.home, state)
  if (tokens.refreshToken) {
    deps.memory.pendingRefresh = tokens.refreshToken
    await savePending(deps)
  }
  return reloadFront(deps.exec, deps.frontContainer)
}

/** Save a refresh token held in memory; on failure keep it and record why (no value). */
export async function savePending(deps: SynapseDeps): Promise<void> {
  const pending = deps.memory.pendingRefresh
  if (pending === undefined) return
  const saved = await deps.store.write(pending).then(() => true, () => false)
  const state = await readState(deps.home)
  if (saved) {
    deps.memory.pendingRefresh = undefined
    if (state?.lastError?.startsWith("refresh token not saved")) await writeState(deps.home, { ...state, lastError: undefined })
    return
  }
  safeLog(deps.log, "warn", "synapse", "synapse refresh token not saved; kept in memory, will retry", { store: deps.store.kind })
  if (state) await writeState(deps.home, { ...state, lastError: `refresh token not saved (${deps.store.kind}); retrying` })
}

/** Keystone refused, or nothing is stored (call under the lock): empty the include; only a sign-in helps. */
export async function failClosed(deps: SynapseDeps, reason: string): Promise<Refreshed> {
  await writeAuthConf(deps.frontDir, undefined)
  deps.memory.pendingRefresh = undefined
  const state = await readState(deps.home)
  await writeState(deps.home, { obtainedAt: state?.obtainedAt ?? 0, expiresAt: state?.expiresAt ?? 0, ...(state?.user ? { user: state.user } : {}), lastError: reason.slice(0, 200), needsSignIn: true })
  safeLog(deps.log, "warn", "synapse", "synapse token failed closed", { reason: reason.slice(0, 200) })
  return { outcome: "failed_closed", reload: await reloadFront(deps.exec, deps.frontContainer), error: reason }
}

/** Sign the owner in on the host and adopt the exchanged token. */
export async function signIn(deps: SynapseDeps): Promise<{ reload: Reload; user?: string; expiresAt: number }> {
  const secrets = await deps.secrets()
  const handoff = await catchHandoff({ origin: deps.origin, opener: deps.opener })
  const tokens = await exchangeHandoff(deps.fetch, deps.origin, handoff, secrets.brokerKey)
  if (!tokens.refreshToken)
    throw new DelegateError("upstream_error", "Keystone gave no refresh token for the Synapse sign-in.", "Check app opencode allows offline_access, then sign in again.", "exchange: no refresh_token")
  const reload = await deps.lock(() => adopt(deps, tokens))
  const state = await readState(deps.home)
  safeLog(deps.log, "info", "synapse", "synapse sign-in adopted", { reload, expiresAt: state?.expiresAt })
  return { reload, ...(state?.user ? { user: state.user } : {}), expiresAt: state?.expiresAt ?? 0 }
}
