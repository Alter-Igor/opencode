// WS2 (#48): the owner's delegated Synapse token, kept and renewed on the HOST.
// - Sign-in (oc_login {server:"synapse"} / `opencode-delegate login synapse`): handoff → exchange
//   (offline) → refresh token into the secret store, access token into front's include, reload.
// - Renewal: every bridge ticks; when the token is past `refreshFraction` of its lifetime (0.8), one
//   bridge at a time (a lock in the bridge home, start-lock.ts) refreshes, writes the include and
//   reloads front. Others see the new state file and do nothing.
// - Fail closed: no refresh token, a refused refresh, or an expired token → the include is emptied,
//   so front sends no credential and Synapse answers 401. oc_doctor says "needs sign-in".
// State on disk (<home>/synapse/state.json) holds times and the owner's id claims, never a token.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { safeLog, type Logger } from "../shared/log.ts"
import type { Exec } from "../supervisor/docker.ts"
import { authConfHasToken, authConfPath, writeAuthConf } from "./auth-conf.ts"
import { catchHandoff, jwtClaims } from "./handoff-login.ts"
import { exchangeHandoff, refreshSynapse, type Fetch, type TokenSet } from "./keystone-token.ts"
import type { AppSecrets } from "./secrets.ts"
import type { SecretStore } from "./secret-store.ts"

export const DEFAULT_REFRESH_FRACTION = 0.8
export const TICK_MS = 15_000

export type TokenState = { obtainedAt: number; expiresAt: number; user?: string; actor?: string; lastError?: string; needsSignIn?: boolean }
export type Reload = "reloaded" | "front_not_running" | "config_invalid"
export type Refreshed = { outcome: "fresh" | "refreshed" | "failed_closed"; reload?: Reload; error?: string }

export type SynapseDeps = {
  home: string
  frontDir: string
  origin: string
  frontContainer: string
  store: SecretStore
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

async function writeState(home: string, state: TokenState): Promise<void> {
  const file = stateFile(home)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 })
  await rename(`${file}.tmp`, file)
}

/** When a refresh is due: `fraction` of the way through the token's lifetime. */
export const refreshAt = (state: Pick<TokenState, "obtainedAt" | "expiresAt">, fraction: number) => state.obtainedAt + Math.floor((state.expiresAt - state.obtainedAt) * fraction)

export const isDue = (state: TokenState | undefined, now: number, fraction: number) => state !== undefined && !state.needsSignIn && now >= refreshAt(state, fraction)

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

/** Take a fresh token set: refresh token to the store, access token to front, state, reload. */
export async function adopt(deps: SynapseDeps, tokens: TokenSet): Promise<Reload> {
  if (tokens.refreshToken) await deps.store.write(tokens.refreshToken)
  await writeAuthConf(deps.frontDir, tokens.accessToken)
  const claims = jwtClaims(tokens.accessToken) ?? {}
  const act = claims.act && typeof claims.act === "object" ? (claims.act as Record<string, unknown>).sub : undefined
  const user = typeof claims.email === "string" ? claims.email : typeof claims.sub === "string" ? claims.sub : undefined
  const now = deps.now()
  await writeState(deps.home, { obtainedAt: now, expiresAt: now + tokens.expiresInSec * 1000, ...(user ? { user } : {}), ...(typeof act === "string" ? { actor: act } : {}) })
  return reloadFront(deps.exec, deps.frontContainer)
}

/** Empty the include and mark the state: no credential leaves front until the owner signs in again. */
export async function failClosed(deps: SynapseDeps, reason: string): Promise<Refreshed> {
  await writeAuthConf(deps.frontDir, undefined)
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

/** Refresh when due (or `force`), one bridge at a time. Never throws for a refused refresh: it fails closed. */
export async function refreshIfDue(deps: SynapseDeps, force = false): Promise<Refreshed> {
  if (!force && !isDue(await readState(deps.home), deps.now(), deps.refreshFraction)) return expireIfPast(deps)
  return deps.lock(async () => {
    // Another bridge may have refreshed while this one waited for the lock.
    const state = await readState(deps.home)
    if (!force && !isDue(state, deps.now(), deps.refreshFraction)) return { outcome: "fresh" as const }
    const refreshToken = await deps.store.read().catch(() => undefined)
    if (!refreshToken) return failClosed(deps, "no stored refresh token")
    try {
      const tokens = await refreshSynapse(deps.fetch, deps.origin, refreshToken, (await deps.secrets()).clientSecret)
      const reload = await adopt(deps, tokens)
      safeLog(deps.log, "info", "synapse", "synapse token refreshed", { reload, rotated: tokens.refreshToken !== undefined })
      return { outcome: "refreshed" as const, reload }
    } catch (error) {
      const reason = isDelegateError(error) ? (error.detail ?? error.message) : "refresh failed"
      if (isDelegateError(error) && error.code === "needs_auth") return failClosed(deps, reason)
      safeLog(deps.log, "warn", "synapse", "synapse refresh failed; will retry", { reason: reason.slice(0, 200) })
      return expireIfPast(deps, reason)
    }
  })
}

/** An access token past its expiry is removed from front even when the refresh only failed for now. */
async function expireIfPast(deps: SynapseDeps, reason?: string): Promise<Refreshed> {
  const state = await readState(deps.home)
  const conf = await readFile(authConfPath(deps.frontDir), "utf8").catch(() => "")
  if (state && deps.now() >= state.expiresAt && authConfHasToken(conf)) return failClosed(deps, reason ?? "access token expired")
  return reason ? { outcome: "fresh", error: reason } : { outcome: "fresh" }
}

/** The renewal loop of one bridge. Returns a stop function. Errors are logged by code, never thrown. */
export function startRefreshLoop(deps: SynapseDeps, tickMs = TICK_MS): () => void {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    await refreshIfDue(deps).catch((error: unknown) => safeLog(deps.log, "warn", "synapse", "synapse refresh tick failed", { reason: isDelegateError(error) ? error.code : "error" }))
    running = false
  }
  const timer = setInterval(() => void tick(), tickMs)
  timer.unref?.()
  void tick()
  return () => clearInterval(timer)
}
