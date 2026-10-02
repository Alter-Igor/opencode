// #67 step 1: the host's NON-SECRET record of each Keystone connection's token set, one file per
// connection under <home>/keystone/. Times, the public client id, needs-sign-in, the last error and
// the pending-save marker. Never a token or a code: the refresh token lives only in the DPAPI store
// (store.ts) and the access token only in this bridge's memory and front's include (via publish).
import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { DelegateError } from "../shared/errors.ts"
import { CONNECTION_ID } from "../shared/keystone.ts"
import { renameWithRetry } from "../synapse/fs-retry.ts"
import { attempt } from "./attempt.ts"

export type KsState = {
  connection: string
  /** Public OAuth client this host registered for the connection (DCR, auth method none). */
  clientId?: string
  /** The redirect and scope that client was registered with; a change needs a new client. */
  clientRedirect?: string
  clientScope?: string
  obtainedAt: number
  expiresAt: number
  /** Keystone refused the refresh, or nothing is stored: only a new sign-in helps. */
  needsSignIn?: boolean
  lastError?: string
  /** Passing failures in a row, and when the next attempt may run (backoff). */
  failures?: number
  retryAt?: number
  /** A bridge holds a rotated refresh token it could not save yet (no value here). Peers wait. */
  pendingBy?: string
  /** The holder process (pid + start time): the marker counts while that process lives. */
  pendingPid?: number
  pendingStartedAt?: number
  /** Refreshed by the holder on every save attempt; a marker older than the window is stale. */
  pendingAt?: number
  /** The holder TRIED to save and failed: the stored refresh token is spent (Keystone rotated it). */
  pendingSaveFailed?: boolean
  /** What front was last given: a bearer, or an empty credential. */
  credential?: "published" | "empty"
  /** The current token set was saved but its access token is not in front yet. */
  needsPublish?: boolean
  publishedAt?: number
}

/**
 * The connection id, checked: it becomes a file name, a DPAPI entropy and a URL path segment, so
 * only Keystone's own slug shape (shared/keystone.ts CONNECTION_ID) is accepted.
 *
 * @param id Keystone connection id
 * @returns the same id
 * @throws DelegateError invalid_input when it is not a slug
 * @example assertConnectionId("rag-read")
 */
export function assertConnectionId(id: string): string {
  if (!CONNECTION_ID.test(id)) throw new DelegateError("invalid_input", "A Keystone connection id must be lower-case letters, digits and '-'.", "Use the connection id as Keystone shows it, for example rag-read.")
  return id
}

export const keystoneDir = (home: string) => path.join(home, "keystone")
export const ksStateFile = (home: string, connectionId: string) => path.join(keystoneDir(home), `${assertConnectionId(connectionId)}.state.json`)

const STATE_SUFFIX = ".state.json"

/**
 * Read one connection's state; undefined when there is none or it is not well-formed.
 *
 * @param home bridge home
 * @param connectionId Keystone connection id
 * @returns the state, or undefined
 * @throws DelegateError invalid_input for a bad id
 * @example const state = await readKsState(home, "rag-read")
 */
export async function readKsState(home: string, connectionId: string): Promise<KsState | undefined> {
  const read = await attempt(() => readFile(ksStateFile(home, connectionId), "utf8"))
  if (!read.ok) return undefined
  try {
    const value = JSON.parse(read.value) as Partial<KsState>
    return value.connection === connectionId && typeof value.obtainedAt === "number" && typeof value.expiresAt === "number" ? (value as KsState) : undefined
  } catch {
    return undefined
  }
}

/**
 * Write one connection's state atomically (tmp + rename). Call under the shared lock.
 *
 * @param home bridge home
 * @param state the full state to write
 * @returns nothing
 * @throws on a filesystem failure
 * @example await writeKsState(home, { connection: "rag-read", obtainedAt: 0, expiresAt: 0 })
 */
export async function writeKsState(home: string, state: KsState): Promise<void> {
  const file = ksStateFile(home, state.connection)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  // Drop undefined keys so a cleared field really disappears from the file.
  const clean = Object.fromEntries(Object.entries(state).filter(([, v]) => v !== undefined))
  await writeFile(tmp, JSON.stringify(clean, null, 2), { encoding: "utf8", mode: 0o600 })
  await renameWithRetry(tmp, file)
}

/**
 * The connections this home holds a state for, sorted.
 *
 * @param home bridge home
 * @returns connection ids
 * @throws never (an unreadable folder is an empty list)
 * @example const ids = await knownConnections(home)
 */
export async function knownConnections(home: string): Promise<string[]> {
  const listed = await attempt(() => readdir(keystoneDir(home)))
  const names = listed.ok ? listed.value : []
  return names.flatMap((n) => (n.endsWith(STATE_SUFFIX) ? [n.slice(0, -STATE_SUFFIX.length)] : [])).filter((id) => CONNECTION_ID.test(id)).sort()
}

/** When a refresh is due: `fraction` of the way through the token's lifetime (as for Synapse). */
export const ksRefreshAt = (state: Pick<KsState, "obtainedAt" | "expiresAt">, fraction: number) => state.obtainedAt + Math.floor((state.expiresAt - state.obtainedAt) * fraction)

/**
 * Due: past the renewal point (or the token is saved but not yet in front) and past the backoff,
 * and not waiting for a sign-in.
 *
 * @param state the connection's state (undefined: never due)
 * @param now host clock, epoch ms
 * @param fraction share of the token's life after which it is renewed (0.8 by default)
 * @returns whether a refresh (or republish) should run now
 * @throws never
 * @example ksIsDue(state, Date.now(), 0.8)
 */
export const ksIsDue = (state: KsState | undefined, now: number, fraction: number) =>
  state !== undefined && !state.needsSignIn && now >= Math.max(state.needsPublish ? 0 : ksRefreshAt(state, fraction), state.retryAt ?? 0)
