// #67 step 1: the owner's Keystone connection tokens, kept and renewed on the HOST, so the delegate
// box never holds one. One public OAuth client and one token set per connection id.
// - Sign-in (signIn): discovery, dynamic registration (reused while the redirect and scope match),
//   the owner's consent in the browser to a loopback listener, the code exchange, then adopt.
// - Renewal (refreshDue / refreshConnection): every bridge ticks; past `refreshFraction` of the
//   token's life (0.8, as for Synapse) one bridge at a time refreshes, under the SAME lock as the
//   Synapse refresh (synapse/lock.ts: one lock for every write of front's files across bridges
//   sharing one home). Every read that decides anything happens under that lock.
// - Keystone rotates refresh tokens STRICTLY (spike, step 0): once a refresh reaches Keystone the old
//   token is spent. So the new refresh token is saved to the DPAPI store BEFORE the new access token
//   is published. If the save fails, the new set stays in this bridge's memory, nothing new is
//   published (front keeps the old access token until it expires), the state carries a marker
//   (`pendingBy`, no value) so peers do not refresh with the spent stored token, and the save is
//   retried on every tick without another grant. The marker names the holder's pid and start
//   time; it counts while that process lives (judged like synapse/lock.ts), not for a fixed time.
//   An access token that cannot be used (too short a life, a malformed reply) never costs the
//   rotated refresh token: it is saved first, nothing is published, and the refresh is retried
//   with backoff using the NEW token. A bridge exit loses an unsaved token: the next
//   refresh then gets invalid_grant and the connection needs a sign-in.
// - Two kinds of failure, as for Synapse (review M2): Keystone refused (invalid_grant, revoked
//   client, ...) or nothing is stored → needs sign-in and an EMPTY credential is published. A passing
//   failure (Keystone down, timeout, a store read error) → retry with backoff; past expiry the
//   credential is emptied, and a later success publishes a bearer again.
// - Publishing is injected (`publish`); this module never writes front's files. It is called under
//   the lock, at most once per connection per tick.
// Never logged, returned, or written to the state file: an access token, a refresh token, a code.
import { randomBytes } from "node:crypto"
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { safeLog, type Logger } from "../shared/log.ts"
import { loopbackRedirect } from "../supervisor/login.ts"
import { backoffMs } from "../synapse/refresh.ts"
import type { SecretStore } from "../synapse/secret-store.ts"
import { TICK_MS } from "../synapse/token-manager.ts"
import { recordGone, type ProcessProbe, type ProcessRecord } from "../supervisor/process.ts"
import { attempt } from "./attempt.ts"
import { loopbackListener, type Listen } from "./callback.ts"
import { authorizationUrl, classify, discoverKeystone, exchangeCode, refreshTokens, registerHostClient, withTimeout, type FetchLike, type TokenReply } from "./oauth.ts"
import { assertConnectionId, knownConnections, ksIsDue, readKsState, writeKsState, type KsState } from "./state.ts"

export type { FetchLike } from "./oauth.ts"

const COMPONENT = "keystone-auth"

/**
 * Hand front one connection's credential: a bearer, or undefined for an EMPTY credential (no
 * Authorization header leaves front). WS-A2 provides the writer of `ks-auth-<id>.conf`; WS-C wires
 * it. Called under the shared lock. A throw means front did not get it; the manager retries.
 * It MUST NOT take the shared lock itself: withStartLock (supervisor/start-lock.ts) is not
 * re-entrant, so a nested acquire from the same process waits on itself until the lock wait
 * (2 min) runs out and then throws.
 */
export type Publish = (connectionId: string, bearer: string | undefined) => Promise<void>

type Client = { clientId: string; clientRedirect?: string; clientScope?: string }

/**
 * A token set this bridge holds in memory. `refreshToken` is set only while it is NOT yet saved;
 * the access token is kept so a failed publish can be retried without another grant. No access
 * token (`unusable` says why) means: save the refresh token, publish nothing, retry later.
 */
type Held = { accessToken: string | undefined; unusable?: string; refreshToken: string | undefined; obtainedAt: number; expiresAt: number; client: Client }

/**
 * Per-bridge memory: `id` names this bridge in pending markers; `held` keeps token sets that are
 * not saved or not published yet, per connection. Lives only in this process, never on disk.
 */
export type KeystoneMemory = { id: string; held: Map<string, Held> }

export type KeystoneAuthDeps = {
  home: string
  /** Keystone origin (https); every endpoint used must be on it. */
  origin: string
  /** The refresh-token store of one connection (DPAPI in production). */
  store: (connectionId: string) => SecretStore
  memory: KeystoneMemory
  fetch: FetchLike
  /** Runs `fn` while holding the machine-wide lock of this bridge home (the Synapse refresh lock). */
  lock: <T>(fn: () => Promise<T>) => Promise<T>
  publish: Publish
  now: () => number
  refreshFraction: number
  /** Opens the authorization URL in the owner's browser. */
  opener: (url: string) => void
  /** Loopback port of the sign-in redirect (LOGIN_PORT in production). */
  loginPort: number
  loginTimeoutMs: number
  log: Logger
  /** The sign-in listener (default: a real loopback HTTP listener). */
  listen?: Listen
  /** Judges whether another bridge's pending marker is still held by a live process. */
  probe: ProcessProbe
  /** This process (pid and start time), written into the pending marker. */
  self: () => Promise<ProcessRecord>
}

/**
 * What one refresh attempt did. fresh: nothing due. refreshed: a new bearer is in front.
 * retrying: a passing failure (or a saved token whose access token was unusable / not taken by
 * front), backing off. expired: past expiry, credential emptied, still retrying. pending_save: a
 * rotated refresh token is held in memory, unsaved; nothing new published. waiting: another live
 * bridge holds an unsaved token. needs_sign_in: refused or nothing stored. signed_out: no state.
 */
export type KsOutcome = "fresh" | "refreshed" | "retrying" | "expired" | "pending_save" | "waiting" | "needs_sign_in" | "signed_out"
export type KsRefreshed = { connection: string; outcome: KsOutcome; error?: string }
export type KsSignIn = { connection: string; outcome: "signed_in" | "pending_save" | "publish_failed" | "access_unusable"; expiresAt: number }

/** Prefix of the error of an "access token unusable" outcome (the refresh token was saved). */
const UNUSABLE = "access token unusable"

const result = (connection: string, outcome: KsOutcome, error?: string): KsRefreshed => ({ connection, outcome, ...(error ? { error } : {}) })
const clientOf = (state: KsState | undefined): Client | undefined =>
  state?.clientId ? { clientId: state.clientId, ...(state.clientRedirect ? { clientRedirect: state.clientRedirect } : {}), ...(state.clientScope ? { clientScope: state.clientScope } : {}) } : undefined

/**
 * This bridge's held set for `id`, if it still belongs to the token set in force; else dropped.
 * A newer set elsewhere (another sign-in or refresh) supersedes it, so a late save can never
 * overwrite a newer refresh token (Synapse review N1).
 */
function currentHeld(deps: KeystoneAuthDeps, id: string, state: KsState | undefined): Held | undefined {
  const held = deps.memory.held.get(id)
  if (held === undefined) return undefined
  const unsaved = held.refreshToken !== undefined
  const superseded = state !== undefined && state.obtainedAt > held.obtainedAt
  // A saved set is only kept to republish the current access token.
  const stale = !unsaved && (held.accessToken === undefined || state === undefined || state.obtainedAt !== held.obtainedAt || state.needsSignIn === true || deps.now() >= held.expiresAt)
  if (!superseded && !stale) return held
  deps.memory.held.delete(id)
  if (unsaved) safeLog(deps.log, "info", COMPONENT, "dropped an unsaved refresh token: a newer sign-in or refresh replaced it", { connection: id })
  return undefined
}

/** Ten minutes: far above the 2-minute lock wait and many 15-second ticks of a retrying holder. */
export const PENDING_MARKER_MAX_AGE_MS = 10 * 60_000

/**
 * Another bridge holds an unsaved refresh token for the current set, its process still lives, and
 * it touched the marker within PENDING_MARKER_MAX_AGE_MS.
 * Judged by pid + start time like the lock holder (synapse/lock.ts via start-lock): a live holder
 * waiting on the lock is never taken for gone, however long it waits, and a reused pid is.
 *
 * @param deps manager dependencies (memory id, probe)
 * @param state the connection's state
 * @returns true while the marker must be honoured
 * @throws never (an unreadable start time keeps the marker: waiting is the safe side)
 * @example if (await pendingMarkerLive(deps, state)) return "waiting"
 */
export async function pendingMarkerLive(deps: Pick<KeystoneAuthDeps, "memory" | "probe" | "now">, state: KsState): Promise<boolean> {
  if (state.pendingBy === undefined || state.pendingBy === deps.memory.id) return false
  // Review cycle 2: a live holder that stopped retrying (connection dropped from its list, loop
  // stopped) must not block peers for ever. The holder rewrites pendingAt on every save attempt
  // (every tick), so only a marker untouched for the whole window is stale.
  if (deps.now() - (state.pendingAt ?? 0) >= PENDING_MARKER_MAX_AGE_MS) return false
  // A marker without a holder record cannot be judged; nothing in this module writes one.
  if (state.pendingPid === undefined) return false
  const gone = await attempt(() => recordGone({ pid: state.pendingPid ?? 0, ...(state.pendingStartedAt !== undefined ? { startedAt: state.pendingStartedAt } : {}) }, deps.probe))
  return !gone.ok || !gone.value
}

/** Save a held refresh token (under the lock). On failure keep it in memory and mark the state. */
async function saveHeld(deps: KeystoneAuthDeps, id: string, held: Held, state: KsState | undefined): Promise<boolean> {
  const store = deps.store(id)
  const token = held.refreshToken
  if (token === undefined) return true
  // The marker goes down BEFORE the store write (review cycle 1, M2): if both fail on one bad disk,
  // the marker attempt came first; if only the store fails, peers already know to wait. It keeps
  // the PREVIOUS set's times, so a newer sign-in still supersedes this held set.
  const me = await deps.self()
  const marker: KsState = { ...(state ?? { connection: id, obtainedAt: 0, expiresAt: 0 }), pendingBy: deps.memory.id, pendingPid: me.pid, ...(me.startedAt !== undefined ? { pendingStartedAt: me.startedAt } : {}), pendingAt: deps.now() }
  const marked = await attempt(() => writeKsState(deps.home, marker))
  const saved = await attempt(() => store.write(token))
  if (saved.ok) {
    held.refreshToken = undefined
    // Review cycle 3: the stored token is current again, so drop the failed-save flag at once (the
    // marker itself stays until the commit). Otherwise a failed commit write plus a silent holder
    // would make a peer fail closed over a valid token. Best effort: if this write fails, the token
    // is still saved and the commit's state write clears the flag anyway.
    if (marker.pendingSaveFailed) {
      const { pendingSaveFailed: _f, lastError, ...cleared } = marker
      await attempt(() => writeKsState(deps.home, { ...cleared, ...(lastError && !lastError.startsWith("refresh token not saved") ? { lastError } : {}) }))
    }
    return true
  }
  safeLog(deps.log, marked.ok ? "warn" : "error", COMPONENT, "keystone refresh token not saved; kept in memory, not published, will retry", { connection: id, store: store.kind, marked: marked.ok })
  if (marked.ok) await attempt(() => writeKsState(deps.home, { ...marker, pendingSaveFailed: true, lastError: `refresh token not saved (${store.kind}); retrying` }))
  return false
}

/**
 * Save this bridge's held (unsaved) refresh token for one connection, under the shared lock,
 * without committing or publishing anything. refreshConnection does this as its first step; it is
 * exported so the save step can be checked on its own.
 *
 * @param deps manager dependencies
 * @param connectionId Keystone connection id
 * @returns true when nothing was pending or the token is now saved, false when the save failed
 * @throws DelegateError invalid_input for a bad id; a lock timeout
 * @example await savePendingRefresh(deps, "rag-read")
 */
export function savePendingRefresh(deps: KeystoneAuthDeps, connectionId: string): Promise<boolean> {
  const id = assertConnectionId(connectionId)
  return deps.lock(async () => {
    const state = await readKsState(deps.home, id)
    const held = currentHeld(deps, id, state)
    return held === undefined ? true : saveHeld(deps, id, held, state)
  })
}

/** The held set is saved: publish its access token, or record why it cannot be used. */
function settleHeld(deps: KeystoneAuthDeps, id: string, held: Held, previous: KsState | undefined): Promise<KsRefreshed> {
  return held.accessToken === undefined ? accessUnusable(deps, id, held, previous) : commitHeld(deps, id, held, previous)
}

/**
 * The refresh token is saved but the access token cannot be used: publish nothing, keep the
 * current set's times (front keeps the old bearer until it expires; a sign-in with no prior set
 * starts expired) and retry with backoff, which will present the NEWLY saved refresh token.
 */
async function accessUnusable(deps: KeystoneAuthDeps, id: string, held: Held, previous: KsState | undefined): Promise<KsRefreshed> {
  deps.memory.held.delete(id)
  const now = deps.now()
  const base: KsState = previous && !previous.needsSignIn ? previous : { connection: id, obtainedAt: now, expiresAt: now, ...(previous?.credential ? { credential: previous.credential } : {}) }
  const { pendingBy: _b, pendingPid: _p, pendingStartedAt: _s, pendingAt: _a, pendingSaveFailed: _f, needsSignIn: _n, ...rest } = base
  const failures = (base.failures ?? 0) + 1
  const reason = `${UNUSABLE} (${held.unusable ?? "unknown"}); refresh token saved`
  const next: KsState = { ...rest, ...held.client, failures, retryAt: now + backoffMs(failures), lastError: reason }
  await writeKsState(deps.home, next)
  safeLog(deps.log, "warn", COMPONENT, "keystone access token unusable; refresh token saved, nothing published, will retry", { connection: id, reason, failures })
  const expired = await expireIfPast(deps, id, next)
  return result(id, expired.outcome === "expired" ? "expired" : "retrying", reason)
}

/** The held set is saved: record it as the set in force, then publish its access token. */
async function commitHeld(deps: KeystoneAuthDeps, id: string, held: Held, previous: KsState | undefined): Promise<KsRefreshed> {
  // Written before publishing, so peers see a fresh set (and no pending marker) at once.
  const next: KsState = { connection: id, ...held.client, obtainedAt: held.obtainedAt, expiresAt: held.expiresAt, needsPublish: true, ...(previous?.credential ? { credential: previous.credential } : {}) }
  await writeKsState(deps.home, next)
  return publishHeld(deps, id, held, next)
}

async function publishHeld(deps: KeystoneAuthDeps, id: string, held: Held, state: KsState): Promise<KsRefreshed> {
  const published = await attempt(() => deps.publish(id, held.accessToken))
  if (!published.ok) {
    const failures = (state.failures ?? 0) + 1
    await writeKsState(deps.home, { ...state, needsPublish: true, failures, retryAt: deps.now() + backoffMs(failures), lastError: "publish to front failed; retrying" })
    safeLog(deps.log, "warn", COMPONENT, "keystone token saved but not published to front; will retry", { connection: id, failures })
    return result(id, "retrying", "publish to front failed")
  }
  const { needsPublish: _n, failures: _f, retryAt: _r, lastError: _e, pendingBy: _b, pendingPid: _p, pendingStartedAt: _s, pendingAt: _a, pendingSaveFailed: _x, ...rest } = state
  await writeKsState(deps.home, { ...rest, credential: "published", publishedAt: deps.now() })
  return result(id, "refreshed")
}

/**
 * Take up a token reply (under the lock): save the refresh token FIRST, before anything about the
 * access token is acted on (review cycle 1, HIGH), then publish it or record it as unusable.
 */
async function adopt(deps: KeystoneAuthDeps, id: string, reply: TokenReply, client: Client, spent?: string): Promise<KsRefreshed> {
  const now = deps.now()
  // Keystone sending back the presented token means nothing new to save.
  const refreshToken = reply.refreshToken !== spent ? reply.refreshToken : undefined
  const usable = "accessToken" in reply.access ? reply.access : undefined
  const held: Held = {
    accessToken: usable?.accessToken,
    ...("unusable" in reply.access ? { unusable: reply.access.unusable } : {}),
    refreshToken,
    obtainedAt: now,
    expiresAt: now + (usable?.expiresInSec ?? 0) * 1000,
    client,
  }
  deps.memory.held.set(id, held)
  const previous = await readKsState(deps.home, id)
  if (!(await saveHeld(deps, id, held, previous))) return result(id, "pending_save", "refresh token not saved yet")
  return settleHeld(deps, id, held, previous)
}

/** Publish an empty credential; returns whether front took it (a throw is logged, not raised). */
async function publishEmpty(deps: KeystoneAuthDeps, id: string): Promise<boolean> {
  const { ok } = await attempt(() => deps.publish(id, undefined))
  if (!ok) safeLog(deps.log, "warn", COMPONENT, "could not empty the keystone credential in front; will retry", { connection: id })
  return ok
}

/** Refused, or nothing stored (under the lock): empty credential, needs sign-in, no more attempts. */
async function failClosed(deps: KeystoneAuthDeps, id: string, state: KsState | undefined, reason: string, forgetClient: boolean): Promise<KsRefreshed> {
  deps.memory.held.delete(id)
  const emptied = await publishEmpty(deps, id)
  const client = forgetClient ? undefined : clientOf(state)
  const credential = emptied ? "empty" : state?.credential
  await writeKsState(deps.home, { connection: id, ...client, obtainedAt: state?.obtainedAt ?? 0, expiresAt: state?.expiresAt ?? 0, needsSignIn: true, lastError: reason.slice(0, 200), ...(credential ? { credential } : {}) })
  safeLog(deps.log, "warn", COMPONENT, "keystone token failed closed; sign in again", { connection: id, reason: reason.slice(0, 200) })
  return result(id, "needs_sign_in", reason)
}

/** Past expiry: take the bearer out of front (not a sign-out; renewal keeps trying). */
async function expireIfPast(deps: KeystoneAuthDeps, id: string, state: KsState | undefined): Promise<KsRefreshed> {
  if (state === undefined || deps.now() < state.expiresAt) return result(id, "fresh")
  if (state.credential === "published" && (await publishEmpty(deps, id))) {
    await writeKsState(deps.home, { ...state, credential: "empty" })
    safeLog(deps.log, "warn", COMPONENT, "keystone token expired; removed from front, renewal keeps retrying", { connection: id })
  }
  return result(id, "expired")
}

/** A passing failure: back off, stay signed in, empty the credential only once expired. */
async function retryLater(deps: KeystoneAuthDeps, id: string, state: KsState, reason: string): Promise<KsRefreshed> {
  const failures = (state.failures ?? 0) + 1
  const next: KsState = { ...state, lastError: reason.slice(0, 200), failures, retryAt: deps.now() + backoffMs(failures) }
  await writeKsState(deps.home, next)
  safeLog(deps.log, "warn", COMPONENT, "keystone refresh failed; will retry", { connection: id, reason: reason.slice(0, 200), failures })
  const expired = await expireIfPast(deps, id, next)
  return result(id, expired.outcome === "expired" ? "expired" : "retrying", reason)
}

async function refreshLocked(deps: KeystoneAuthDeps, id: string, force: boolean): Promise<KsRefreshed> {
  const state = await readKsState(deps.home, id)
  const held = currentHeld(deps, id, state)
  // 1. A rotated refresh token not saved yet: only retry the save, never another grant.
  if (held?.refreshToken !== undefined) {
    if (!(await saveHeld(deps, id, held, state))) {
      await expireIfPast(deps, id, await readKsState(deps.home, id))
      return result(id, "pending_save", "refresh token not saved yet")
    }
    return settleHeld(deps, id, held, state)
  }
  if (state === undefined) return result(id, "signed_out")
  if (state.needsSignIn) {
    // An earlier empty publish may have failed: keep trying until front holds no credential.
    if (state.credential === "published" && (await publishEmpty(deps, id))) await writeKsState(deps.home, { ...state, credential: "empty" })
    return result(id, "needs_sign_in", state.lastError)
  }
  const now = deps.now()
  // 2. Saved but not in front: republish from memory when this bridge still holds the access token.
  if (state.needsPublish && now >= (state.retryAt ?? 0) && held?.accessToken !== undefined) return publishHeld(deps, id, held, state)
  if (!force && !ksIsDue(state, now, deps.refreshFraction)) return expireIfPast(deps, id, state)
  // 3. Another bridge holds the rotated token in memory; the stored one is spent. Wait for it, even
  // when forced: refreshing with the spent token would get invalid_grant and lose the sign-in.
  if (await pendingMarkerLive(deps, state)) {
    const expired = await expireIfPast(deps, id, state)
    return result(id, expired.outcome === "expired" ? "expired" : "waiting", "another bridge holds an unsaved refresh token")
  }
  // 4. Review cycle 2 decision: another bridge's marker is no longer honoured (holder gone, or alive
  // but silent past the window) and it says that bridge FAILED to save its rotated token. Then the
  // stored token is spent: presenting it would only earn invalid_grant (and may trip Keystone's
  // reuse detection). Fail closed without using it. If the holder is in fact still alive and later
  // saves, its commit replaces this needs-sign-in state (same obtainedAt, so it is not superseded).
  // A stale marker WITHOUT the flag may belong to a save that completed (only the state write
  // after it failed), so the stored token may be current: the refresh below goes ahead.
  if (state.pendingBy !== undefined && state.pendingBy !== deps.memory.id && state.pendingSaveFailed)
    return failClosed(deps, id, state, "another bridge could not save the rotated refresh token; the stored one is spent", false)
  const client = clientOf(state)
  if (client === undefined) return failClosed(deps, id, state, "no registered client", false)
  const store = deps.store(id)
  const stored = await attempt(() => store.read())
  // A read ERROR is not "missing": it is retried, never a reason to drop the sign-in.
  if (!stored.ok) return retryLater(deps, id, state, `refresh token store (${store.kind}) could not be read`)
  const storedToken = stored.value
  if (storedToken === undefined) return failClosed(deps, id, state, "no stored refresh token", false)
  let tokens: TokenReply
  try {
    const fetchFn = withTimeout(deps.fetch)
    const server = await discoverKeystone(fetchFn, deps.origin, id)
    tokens = await refreshTokens(fetchFn, server, client.clientId, storedToken, deps.now())
  } catch (error) {
    const failure = classify("refresh", error)
    return failure.kind === "needs_sign_in" ? failClosed(deps, id, state, failure.reason, failure.forgetClient) : retryLater(deps, id, state, failure.reason)
  }
  const adopted = await adopt(deps, id, tokens, client, storedToken)
  safeLog(deps.log, "info", COMPONENT, "keystone token refreshed", { connection: id, outcome: adopted.outcome })
  return adopted
}

/**
 * Refresh one connection when due (or `force`), under the shared lock. Never throws for a failed
 * refresh; the outcome says what happened.
 *
 * @param deps manager dependencies
 * @param connectionId Keystone connection id
 * @param force refresh even when not due (still waits for another bridge's unsaved token)
 * @returns the outcome for this connection
 * @throws DelegateError invalid_input for a bad id; a lock timeout or a state-file write error
 * @example await refreshConnection(deps, "rag-read")
 */
export function refreshConnection(deps: KeystoneAuthDeps, connectionId: string, force = false): Promise<KsRefreshed> {
  const id = assertConnectionId(connectionId)
  return deps.lock(() => refreshLocked(deps, id, force))
}

/**
 * One tick: every due connection (all this home knows, or only `connectionIds`), each under the
 * lock, one after another. Publishes at most once per connection. Never throws.
 *
 * @param deps manager dependencies
 * @param connectionIds optional subset (e.g. the profile's chosen connections)
 * @returns one outcome per connection
 * @throws never
 * @example const outcomes = await refreshDue(deps, ["rag-read", "github"])
 */
export async function refreshDue(deps: KeystoneAuthDeps, connectionIds?: readonly string[]): Promise<KsRefreshed[]> {
  const ids = connectionIds ? [...connectionIds] : await knownConnections(deps.home)
  const outcomes: KsRefreshed[] = []
  for (const id of ids) {
    const outcome = await attempt(() => refreshConnection(deps, id))
    if (outcome.ok) {
      outcomes.push(outcome.value)
      continue
    }
    const error = outcome.error
    const reason = isDelegateError(error) ? error.code : error instanceof Error ? error.name : "error"
    safeLog(deps.log, "warn", COMPONENT, "keystone refresh tick failed", { connection: id, reason })
    outcomes.push(result(id, "retrying", `tick failed (${reason})`))
  }
  return outcomes
}

/**
 * The renewal loop of one bridge. Returns a stop function.
 *
 * @param deps manager dependencies
 * @param connectionIds the connections to keep fresh (read on every tick), or undefined for all known
 * @param tickMs tick period (15 s, as for Synapse)
 * @returns stop function
 * @throws never
 * @example const stop = startKeystoneRefreshLoop(deps, () => profile.connections)
 */
export function startKeystoneRefreshLoop(deps: KeystoneAuthDeps, connectionIds?: () => readonly string[] | undefined, tickMs = TICK_MS): () => void {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      let ids: readonly string[] | undefined
      try {
        ids = connectionIds?.()
      } catch (error) {
        // A failing list must not stop renewal for good: log, skip this tick, try again next one.
        safeLog(deps.log, "warn", COMPONENT, "keystone connection list failed; skipping this tick", { reason: error instanceof Error ? error.name : "error" })
        return
      }
      await refreshDue(deps, ids)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), tickMs)
  timer.unref?.()
  void tick()
  return () => clearInterval(timer)
}

/** The client registration is refused or gone: forget it so the next sign-in registers anew. */
async function forgetClient(deps: KeystoneAuthDeps, id: string): Promise<void> {
  const state = await readKsState(deps.home, id)
  if (state?.clientId === undefined) return
  const { clientId: _c, clientRedirect: _r, clientScope: _s, ...rest } = state
  await writeKsState(deps.home, rest)
}

/**
 * Sign the owner in to one Keystone connection on the HOST and adopt the tokens: discovery, public
 * client registration (reused while redirect and scope match), consent in the owner's browser to a
 * loopback listener, code exchange (PKCE), then save-before-publish under the shared lock.
 *
 * @param deps manager dependencies
 * @param connectionId Keystone connection id
 * @returns the outcome and the new expiry (no token)
 * @throws DelegateError: invalid_input, policy_violation, port_busy, needs_auth (refused, timeout), upstream_error
 * @example await signIn(deps, "rag-read")
 */
export async function signIn(deps: KeystoneAuthDeps, connectionId: string): Promise<KsSignIn> {
  const id = assertConnectionId(connectionId)
  const fetchFn = withTimeout(deps.fetch)
  let tokens: TokenReply
  let client: Client
  try {
    const server = await discoverKeystone(fetchFn, deps.origin, id)
    const listener = await (deps.listen ?? loopbackListener)(deps.loginPort)
    try {
      const redirect = loopbackRedirect(listener.port)
      const previous = clientOf(await readKsState(deps.home, id))
      const reuse = previous !== undefined && previous.clientRedirect === redirect && previous.clientScope === server.scope
      const clientId = reuse ? previous.clientId : await registerHostClient(fetchFn, server, redirect)
      client = { clientId, clientRedirect: redirect, ...(server.scope ? { clientScope: server.scope } : {}) }
      const state = randomBytes(32).toString("base64url")
      const { url, codeVerifier } = await authorizationUrl(server, clientId, redirect, state)
      // Wrapped so that, if the opener throws, the later timeout cannot become an unhandled rejection.
      const callback = attempt(() => listener.wait(state, deps.loginTimeoutMs))
      deps.opener(url.href)
      const code = await callback
      if (!code.ok) throw code.error
      tokens = await exchangeCode(fetchFn, server, clientId, code.value, codeVerifier, redirect, deps.now())
    } finally {
      await listener.close()
    }
  } catch (error) {
    const failure = classify("sign-in", error)
    // Keystone can also refuse a reused client on the consent page; the callback then names it.
    const refusedClient = isDelegateError(error) && /^callback: (invalid_client|unauthorized_client)$/.test(error.detail ?? "")
    if (failure.forgetClient || refusedClient) await attempt(() => deps.lock(() => forgetClient(deps, id)))
    safeLog(deps.log, "warn", COMPONENT, "keystone sign-in failed", { connection: id, reason: failure.reason })
    // An SDK error message can carry Keystone's raw answer; only the classified reason goes out.
    if (isDelegateError(error)) throw error
    throw new DelegateError(failure.kind === "needs_sign_in" ? "needs_auth" : "upstream_error", "Keystone sign-in failed.", "Sign in again; if it repeats, run oc_doctor.", failure.reason)
  }
  if (tokens.refreshToken === undefined)
    throw new DelegateError("upstream_error", "Keystone gave no refresh token for this connection.", "Check the connection allows refresh, then sign in again.", "exchange: no refresh_token")
  const adopted = await deps.lock(() => adopt(deps, id, tokens, client))
  const outcome = adopted.outcome === "refreshed" ? "signed_in" : adopted.outcome === "pending_save" ? "pending_save" : adopted.error?.startsWith(UNUSABLE) ? "access_unusable" : "publish_failed"
  const state = await readKsState(deps.home, id)
  safeLog(deps.log, "info", COMPONENT, "keystone sign-in adopted", { connection: id, outcome })
  return { connection: id, outcome, expiresAt: state?.needsSignIn ? 0 : (state?.expiresAt ?? 0) }
}
