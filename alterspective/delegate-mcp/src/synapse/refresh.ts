// WS2 (#48): renewal of the owner's Synapse token (see token-manager.ts for the model).
// Review M2: a refused refresh (Keystone 400/401/403) or no stored refresh token → needs sign-in.
// A passing failure (Keystone down, timeout, a store READ error) → retry with backoff, keep the
// token until it expires, then empty the include but keep retrying; a later success restores it.
import { readFile } from "node:fs/promises"
import { isDelegateError } from "../shared/errors.ts"
import { safeLog } from "../shared/log.ts"
import { authConfHasToken, authConfPath, writeAuthConf } from "./auth-conf.ts"
import { refreshSynapse } from "./keystone-token.ts"
import { TICK_MS, adopt, currentPending, failClosed, isDue, pendingElsewhere, readState, reloadFront, savePending, writeState, type Refreshed, type SynapseDeps, type TokenState } from "./token-manager.ts"

export const RETRY_BASE_MS = 30_000
export const RETRY_MAX_MS = 10 * 60_000

export const backoffMs = (failures: number) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1))
/** A transient reload failure is retried after one tick, then doubling, at most 5 min apart. */
export const RELOAD_RETRY_MAX_MS = 5 * 60_000
export const reloadBackoffMs = (failures: number) => Math.min(RELOAD_RETRY_MAX_MS, TICK_MS * 2 ** Math.max(0, failures - 1))

const includeHasToken = async (deps: SynapseDeps) => authConfHasToken(await readFile(authConfPath(deps.frontDir), "utf8").catch(() => ""))
const pastExpiry = (state: TokenState | undefined, now: number) => state !== undefined && now >= state.expiresAt
/** Only a transient failure (it carries `failures`) is retried on the timer, once its backoff ends. */
const reloadRetryDue = (state: TokenState | undefined, now: number) => {
  const last = state?.lastReload
  return last?.failures !== undefined && now >= last.at + reloadBackoffMs(last.failures)
}

/**
 * Review L5: signed in, not expired, outside any backoff, yet front's include has no token (it was
 * re-created or emptied). Nothing else would write it before the renewal point, so refresh now.
 */
const includeLost = async (deps: SynapseDeps, state: TokenState | undefined) =>
  state !== undefined && !state.needsSignIn && !pastExpiry(state, deps.now()) && deps.now() >= (state.retryAt ?? 0) && !(await includeHasToken(deps))

/**
 * Refresh when due (or `force`), one bridge at a time. Never throws for a failed refresh. Every
 * read that decides anything happens under the lock (review N2): one tick = one short lock.
 */
export function refreshIfDue(deps: SynapseDeps, force = false): Promise<Refreshed> {
  return deps.lock(() => refreshLocked(deps, force))
}

async function refreshLocked(deps: SynapseDeps, force: boolean): Promise<Refreshed> {
  await savePending(deps)
  const state = await readState(deps.home)
  if (!force && !isDue(state, deps.now(), deps.refreshFraction) && !(await includeLost(deps, state))) {
    const expired = await expireIfPast(deps, state)
    if (expired.reload || !reloadRetryDue(state, deps.now())) return expired
    // Publishing the token and loading it are separate steps. Retry a transient load failure with
    // backoff, without rotating again or waiting until the newly issued token's next renewal point.
    // front_not_running and config_changed do not clear by themselves: front loads the current
    // files when it starts, and a changed servers.conf needs a sandbox restart.
    return { ...expired, reload: await reloadFront(deps) }
  }
  // N1: another bridge holds the rotated refresh token in memory; the stored one is stale. Wait for it.
  if (!force && pendingElsewhere(deps, state)) return { ...(await expireIfPast(deps, state)), error: "another bridge holds an unsaved refresh token" }
  const stored = await readRefreshToken(deps)
  if ("error" in stored) return retryLater(deps, state, stored.error)
  if (stored.token === undefined) return failClosed(deps, "no stored refresh token")
  try {
    const tokens = await refreshSynapse(deps.fetch, deps.origin, stored.token, (await deps.secrets()).clientSecret)
    const reload = await adopt(deps, tokens)
    safeLog(deps.log, "info", "synapse", "synapse token refreshed", { reload, rotated: tokens.refreshToken !== undefined })
    return { outcome: "refreshed", reload }
  } catch (error) {
    const reason = isDelegateError(error) ? (error.detail ?? error.message) : "refresh failed"
    if (isDelegateError(error) && error.code === "needs_auth") return failClosed(deps, reason)
    return retryLater(deps, await readState(deps.home), reason)
  }
}

/** The token to refresh with: one held in memory first, else the store. A read ERROR is not "missing". */
async function readRefreshToken(deps: SynapseDeps): Promise<{ token: string | undefined } | { error: string }> {
  const pending = currentPending(deps, await readState(deps.home))
  if (pending !== undefined) return { token: pending }
  return deps.store.read().then(
    (token) => ({ token }),
    () => ({ error: `refresh token store (${deps.store.kind}) could not be read` }),
  )
}

/** A passing failure: back off, keep the state signed in, and empty the include only once expired. */
async function retryLater(deps: SynapseDeps, state: TokenState | undefined, reason: string): Promise<Refreshed> {
  const failures = (state?.failures ?? 0) + 1
  const next: TokenState = { ...state, obtainedAt: state?.obtainedAt ?? 0, expiresAt: state?.expiresAt ?? 0, lastError: reason.slice(0, 200), failures, retryAt: deps.now() + backoffMs(failures) }
  await writeState(deps.home, next)
  safeLog(deps.log, "warn", "synapse", "synapse refresh failed; will retry", { reason: reason.slice(0, 200), failures })
  const expired = await expireIfPast(deps, next)
  return { outcome: pastExpiry(next, deps.now()) ? "expired" : "retrying", ...(expired.reload ? { reload: expired.reload } : {}), error: reason }
}

/** Past expiry: take the token out of front (no credential leaves front). Not a sign-out. */
async function expireIfPast(deps: SynapseDeps, state: TokenState | undefined): Promise<Refreshed> {
  if (!pastExpiry(state, deps.now()) || !(await includeHasToken(deps))) return { outcome: "fresh" }
  await writeAuthConf(deps.frontDir, undefined)
  if (state) await writeState(deps.home, { ...state, includeAt: deps.now() })
  safeLog(deps.log, "warn", "synapse", "synapse token expired; removed from front, renewal keeps retrying", {})
  return { outcome: "expired", reload: await reloadFront(deps) }
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

