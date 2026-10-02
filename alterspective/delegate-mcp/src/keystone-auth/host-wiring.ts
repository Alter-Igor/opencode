// #67 step 4 (WS-C): how the host Keystone token manager (manager.ts) reaches front and the box.
// - createKsPublisher: the manager's `publish`. It writes front's ks-auth-<id>.conf (WS-A2's
//   writer) and reloads front through the same baked front-reload the Synapse refresh uses. The
//   manager calls it while it HOLDS the shared lock (synapse/lock.ts), and that lock is not
//   re-entrant, so nothing here takes it: writeKsAuthConf and reloadFront never lock.
// - ensureEntryConnected: OpenCode does not reconnect an `oauth: false` entry by itself after a
//   token gap, so after a bearer is published the bridge asks the box to connect the entry
//   (POST /mcp/<entry>/connect) when it is not connected. That call runs after publish returns
//   its promise, outside the manager's work, and a failure is logged, never thrown into it.
// Never logged or returned here: the token. Only the connection id, the credential kind and states.
import { DelegateError } from "../shared/errors.ts"
import { entryName, idOfEntry } from "../shared/keystone.ts"
import { safeLog, type Logger } from "../shared/log.ts"
import type { McpStatus, OpencodeApi } from "../shared/opencode-api.ts"
import { writeKsAuthConf } from "../synapse/auth-conf.ts"
import type { Reload } from "../synapse/token-manager.ts"
import type { Publish } from "./manager.ts"
import type { KsStatus } from "./report.ts"

const COMPONENT = "keystone-auth"
/** The instance directory the bridge's box calls use. */
const DIRECTORY = "/sessions"

/** A reload that leaves front serving the new file: reloaded now, or loaded when front starts. */
const PUBLISHED: ReadonlySet<Reload> = new Set<Reload>(["reloaded", "front_not_running"])

export type KsPublisherDeps = {
  /** The bridge home's front folder (shared/config.ts frontDir). */
  frontDir: string
  /** Reload front (synapse/token-manager.ts reloadFront). MUST NOT take the shared lock. */
  reload: () => Promise<Reload>
  /** Connect one box entry after a bearer is published (ensureEntryConnected on the held box). */
  connect: (entry: string) => Promise<unknown>
  log: Logger
  /** The include writer (default writeKsAuthConf); injectable for tests. */
  write?: (frontDir: string, id: string, token: string | undefined) => Promise<void>
}

/**
 * Build the manager's `publish`: write the connection's front include, reload front, then (for a
 * bearer) connect the box entry in the background.
 *
 * @param deps front folder, reload, connect and logger
 * @returns a Publish to pass to createKeystoneAuth
 * @throws the returned function throws when the file cannot be written or front did not load it,
 *   so the manager keeps the credential and retries; the error names the reload result, never the token
 * @example createKeystoneAuth(config, env, log, createKsPublisher({ frontDir, reload, connect, log }))
 */
export function createKsPublisher(deps: KsPublisherDeps): Publish {
  const write = deps.write ?? writeKsAuthConf
  // Never throws: a connect failure is logged and must not reach the manager's locked work.
  const connectInBackground = async (entry: string): Promise<void> => {
    try {
      await deps.connect(entry)
    } catch (error) {
      safeLog(deps.log, "warn", COMPONENT, "keystone entry connect failed", { entry, reason: error instanceof Error ? error.message.slice(0, 200) : "error" })
    }
  }
  return async (connectionId, bearer) => {
    // Lock hold time: this runs under the shared lock. The write is local; reloadFront is bounded by
    // its docker exec (30 s) plus, on failure, one docker inspect (20 s), about 50 s in all, well
    // inside the 2-minute lock wait (SYNAPSE_LOCK_WAIT_MS) other bridges allow. Inherited from step 1.
    await write(deps.frontDir, connectionId, bearer)
    const reload = await deps.reload()
    const credential = bearer === undefined ? "empty" : "published"
    safeLog(deps.log, PUBLISHED.has(reload) ? "info" : "warn", COMPONENT, "keystone credential published", { connection: connectionId, credential, reload })
    if (!PUBLISHED.has(reload)) throw new Error(`front did not load the new Keystone credential for ${connectionId} (reload: ${reload})`)
    if (bearer === undefined) return
    void connectInBackground(entryName(connectionId))
  }
}

/** One connect per (box API, entry) at a time: the publisher, oc_login, a tick and oc_doctor may overlap. */
const inFlight = new WeakMap<OpencodeApi, Map<string, Promise<string>>>()

async function entryStatus(api: OpencodeApi, entry: string): Promise<string> {
  const res = await api.call<Record<string, McpStatus>>({ path: "/mcp", directory: DIRECTORY })
  const status = res.status === 200 ? res.data?.[entry]?.status : undefined
  return typeof status === "string" ? status : "missing"
}

/**
 * Make sure the box has a ks-<id> entry connected: nothing when it already is, else
 * POST /mcp/<entry>/connect and read its status again.
 *
 * @param api the held box's API
 * @param entry a ks-<id> entry name
 * @param log bridge logger
 * @returns the entry's status after the attempt (connected, failed, missing, ...)
 * @throws DelegateError invalid_input for a name that is not a ks-<id> entry; API errors pass through
 * @example await ensureEntryConnected(box.api, "ks-rag-read", log)
 */
export async function ensureEntryConnected(api: OpencodeApi, entry: string, log: Logger): Promise<string> {
  if (idOfEntry(entry) === undefined) throw new DelegateError("invalid_input", "Only ks-<id> entries can be connected.", "Pass a ks-<id> server name.")
  const running = inFlight.get(api) ?? new Map<string, Promise<string>>()
  inFlight.set(api, running)
  const pending = running.get(entry)
  if (pending) return pending
  const attempt = connectOnce(api, entry, log)
  running.set(entry, attempt)
  try {
    return await attempt
  } finally {
    running.delete(entry)
  }
}

async function connectOnce(api: OpencodeApi, entry: string, log: Logger): Promise<string> {
  const before = await entryStatus(api, entry)
  if (before === "connected") return before
  const res = await api.call({ method: "POST", path: `/mcp/${entry}/connect`, directory: DIRECTORY })
  const after = await entryStatus(api, entry)
  safeLog(log, after === "connected" ? "info" : "warn", COMPONENT, "keystone entry connect", { entry, before, http: res.status, after })
  return after
}

/**
 * When this bridge gets a box (first use, or after a restart), connect every chosen entry whose
 * host token is signed in: a renewal that happened while the bridge held no box connected nothing.
 *
 * @param status the host token states (keystone-auth status)
 * @param ids the chosen connection ids
 * @param api the new box's API
 * @param log bridge logger
 * @returns entry name → status after the attempt (a failed attempt is "unknown"); never throws
 * @example manager.onBox((box) => void connectSignedIn(ks.status, ids(), box.api, log))
 */
export async function connectSignedIn(status: (ids: readonly string[]) => Promise<KsStatus[]>, ids: readonly string[], api: OpencodeApi, log: Logger): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  let states: KsStatus[]
  try {
    states = await status(ids)
  } catch (error) {
    safeLog(log, "warn", COMPONENT, "keystone states unreadable; box entries not connected", { reason: error instanceof Error ? error.name : "error" })
    return out
  }
  for (const state of states.filter((s) => s.state === "signed_in")) {
    const entry = entryName(state.connection)
    try {
      out[entry] = await ensureEntryConnected(api, entry, log)
    } catch {
      out[entry] = "unknown"
    }
  }
  return out
}

/**
 * One reconnect pass on the box this bridge holds (nothing without one). Every bridge runs it, so a
 * box held by several bridges is reconnected even when another bridge renewed the token.
 *
 * @param heldApi the held box's API, or undefined
 * @param status the host token states
 * @param ids the chosen connection ids, read now
 * @param log bridge logger
 * @returns entry name → status after the attempt; never throws
 * @example await reconnectTick(() => manager.peek()?.api, (ids) => ks.status(ids), () => currentKeystone(config).connections, log)
 */
export async function reconnectTick(heldApi: () => OpencodeApi | undefined, status: (ids: readonly string[]) => Promise<KsStatus[]>, ids: () => readonly string[], log: Logger): Promise<Record<string, string>> {
  const api = heldApi()
  if (!api) return {}
  let chosen: readonly string[]
  try {
    chosen = ids()
  } catch (error) {
    safeLog(log, "warn", COMPONENT, "keystone connection list failed; reconnect skipped", { reason: error instanceof Error ? error.name : "error" })
    return {}
  }
  return connectSignedIn(status, chosen, api, log)
}

/** How often each bridge checks its held box's ks-* entries (one GET /mcp; a connect only when needed). */
export const RECONNECT_TICK_MS = 60_000

/**
 * Run reconnectTick every `tickMs` (single-flight). Returns a stop function.
 *
 * @example const stop = startReconnectLoop(() => manager.peek()?.api, (ids) => ks.status(ids), ids, log)
 */
export function startReconnectLoop(heldApi: () => OpencodeApi | undefined, status: (ids: readonly string[]) => Promise<KsStatus[]>, ids: () => readonly string[], log: Logger, tickMs = RECONNECT_TICK_MS): () => void {
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await reconnectTick(heldApi, status, ids, log)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), tickMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
