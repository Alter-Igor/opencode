// Review N1 (confirmation review of e1df93ae5c): ONE lock for every write of front's generated files
// and every reload of front. The Synapse refresh (refresh.ts, token-manager.ts) writes the include and
// reloads under it; a sandbox start (supervisor/lifecycle.ts prepareFiles) writes servers.conf and
// the include under it too. So front-reload can never pass its check on one servers.conf and then
// have nginx load another one written by a start in between.
// Lock order (no deadlock): the sandbox start lock first, then this one. The Synapse
// code never takes the start lock, so the reverse order cannot happen.
import path from "node:path"

/** How long a waiter waits, and how old a silent holder's heartbeat may get, before giving up / taking over. */
export const SYNAPSE_LOCK_WAIT_MS = 2 * 60_000

export const synapseLockFile = (home: string) => path.join(home, "synapse", "refresh.lock")
