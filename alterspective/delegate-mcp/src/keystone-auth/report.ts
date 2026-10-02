// #67 step 1: oc_doctor's view of the host-held Keystone tokens (WS-C wires it). States and times
// only, never a value. Whether front actually serves the credential is front's own check (WS-A2/C).
import { attempt } from "./attempt.ts"
import { pendingMarkerLive, type KeystoneAuthDeps } from "./manager.ts"
import { assertConnectionId, knownConnections, ksRefreshAt, readKsState } from "./state.ts"

export type KsStatus = {
  connection: string
  /**
   * signed_in: a bearer was published and is not expired. pending_save: a rotated refresh token is
   * held in memory because the store could not save it (nothing new published meanwhile).
   * publish_pending: saved but front has not taken the access token yet (retried with backoff).
   * retrying: a passing failure (Keystone down, store read error), backing off. expired: past expiry,
   * credential emptied, renewal still retrying. needs_sign_in: refused or nothing stored.
   * signed_out: never signed in on this home.
   */
  state: "signed_in" | "pending_save" | "publish_pending" | "retrying" | "expired" | "needs_sign_in" | "signed_out"
  expiresAt?: string
  refreshAt?: string
  nextRetryAt?: string
  refreshTokenStored: boolean
  pendingSave: boolean
  clientRegistered: boolean
  /** What front was last given: a bearer or an empty credential. */
  credential?: "published" | "empty"
  store: string
  lastError?: string
}

/**
 * Status of every connection this home knows (or only `connectionIds`). Reads only; no lock.
 *
 * @param deps manager dependencies
 * @param connectionIds optional subset
 * @returns one status per connection, without any token
 * @throws DelegateError invalid_input for a bad id
 * @example const statuses = await keystoneAuthStatus(deps)
 */
export async function keystoneAuthStatus(deps: KeystoneAuthDeps, connectionIds?: readonly string[]): Promise<KsStatus[]> {
  const ids = connectionIds ? connectionIds.map(assertConnectionId) : await knownConnections(deps.home)
  return Promise.all(
    ids.map(async (id): Promise<KsStatus> => {
      const state = await readKsState(deps.home, id)
      const store = deps.store(id)
      const has = await attempt(() => store.has())
      const stored = has.ok && has.value
      // A marker counts only while its holder lives (this bridge, or a live peer process).
      const markerHeld = state?.pendingBy !== undefined && (state.pendingBy === deps.memory.id || (await pendingMarkerLive(deps, state)))
      const pendingSave = deps.memory.held.get(id)?.refreshToken !== undefined || markerHeld
      const now = deps.now()
      const kind: KsStatus["state"] =
        state === undefined && !pendingSave ? "signed_out"
        : pendingSave ? "pending_save"
        : state === undefined || state.needsSignIn || !stored ? "needs_sign_in"
        : now >= state.expiresAt ? "expired"
        : state.needsPublish ? "publish_pending"
        : state.failures ? "retrying"
        : "signed_in"
      return {
        connection: id,
        state: kind,
        ...(state && state.expiresAt > 0 ? { expiresAt: new Date(state.expiresAt).toISOString(), refreshAt: new Date(ksRefreshAt(state, deps.refreshFraction)).toISOString() } : {}),
        ...(state?.retryAt ? { nextRetryAt: new Date(state.retryAt).toISOString() } : {}),
        refreshTokenStored: stored,
        pendingSave,
        clientRegistered: state?.clientId !== undefined,
        ...(state?.credential ? { credential: state.credential } : {}),
        store: store.kind,
        ...(state?.lastError ? { lastError: state.lastError } : {}),
      }
    }),
  )
}
