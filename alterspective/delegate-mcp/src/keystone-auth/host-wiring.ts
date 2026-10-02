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
  return async (connectionId, bearer) => {
    await write(deps.frontDir, connectionId, bearer)
    const reload = await deps.reload()
    const credential = bearer === undefined ? "empty" : "published"
    safeLog(deps.log, PUBLISHED.has(reload) ? "info" : "warn", COMPONENT, "keystone credential published", { connection: connectionId, credential, reload })
    if (!PUBLISHED.has(reload)) throw new Error(`front did not load the new Keystone credential for ${connectionId} (reload: ${reload})`)
    if (bearer === undefined) return
    const entry = entryName(connectionId)
    void deps.connect(entry).catch((error: unknown) =>
      safeLog(deps.log, "warn", COMPONENT, "keystone entry connect failed", { entry, reason: error instanceof Error ? error.message.slice(0, 200) : "error" }),
    )
  }
}

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
    out[entry] = await ensureEntryConnected(api, entry, log).catch(() => "unknown")
  }
  return out
}
