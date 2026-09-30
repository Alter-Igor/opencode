// MOD-03 T3.3: read session state from the server (reconnect rebuild and view()).
// Idle sessions are ABSENT from GET /session/status (session/status.ts:42-46), and so are deleted
// and wrong-directory sessions, so absence is resolved with GET /session/:id: 200 → idle,
// 404 → not_found. Pending requests come from GET /permission and GET /question. There is no
// event replay, so this read is the only truth after a gap. Errors propagate (server_down etc.).
import { DelegateError } from "../shared/errors.ts"
import { expectOk, type OpencodeApi } from "../shared/opencode-api.ts"
import { isObj } from "./normalise.ts"
import type { PendingKind, SnapshotEntry } from "./state.ts"

type StatusMap = Map<string, { base: "busy" | "retry"; detail?: string }>
type PendingMap = Map<string, Array<{ requestID: string; kind: PendingKind }>>
type DirectoryRead = { status: StatusMap; pending: PendingMap }

const enc = encodeURIComponent

async function readStatus(api: OpencodeApi, directory: string): Promise<StatusMap> {
  const data = expectOk(await api.call<unknown>({ path: "/session/status", directory }), "read session status")
  const out: StatusMap = new Map()
  if (!isObj(data)) return out
  for (const [id, value] of Object.entries(data)) {
    if (!isObj(value)) continue
    if (value.type === "busy") out.set(id, { base: "busy" })
    if (value.type === "retry") out.set(id, { base: "retry", detail: typeof value.attempt === "number" ? `retry attempt ${value.attempt}` : undefined })
  }
  return out
}

async function readPending(api: OpencodeApi, directory: string, kind: PendingKind, into: PendingMap): Promise<void> {
  const path = kind === "permission" ? "/permission" : "/question"
  const data = expectOk(await api.call<unknown>({ path, directory }), `list pending ${kind}s`)
  if (!Array.isArray(data)) return
  for (const item of data) {
    if (!isObj(item) || typeof item.id !== "string" || typeof item.sessionID !== "string") continue
    const list = into.get(item.sessionID) ?? []
    list.push({ requestID: item.id, kind })
    into.set(item.sessionID, list)
  }
}

async function readDirectory(api: OpencodeApi, directory: string): Promise<DirectoryRead> {
  const pending: PendingMap = new Map()
  const [status] = await Promise.all([readStatus(api, directory), readPending(api, directory, "permission", pending), readPending(api, directory, "question", pending)])
  return { status, pending }
}

export type SessionInfo = { id: string; directory?: string }

/** GET /session/:id → info, or undefined on 404. Any other failure throws. */
export async function readSession(api: OpencodeApi, sessionID: string, directory?: string): Promise<SessionInfo | undefined> {
  const res = await api.call<unknown>({ path: `/session/${enc(sessionID)}`, directory })
  if (res.status === 404) return undefined
  const data = expectOk(res, "read the session")
  if (!isObj(data) || typeof data.id !== "string") throw new DelegateError("upstream_error", "The delegate server returned an unexpected session.", "Retry; if it repeats, run oc_doctor.")
  return { id: data.id, directory: typeof data.directory === "string" ? data.directory : undefined }
}

async function resolveAbsent(api: OpencodeApi, sessionID: string, directory: string): Promise<SnapshotEntry["base"]> {
  const info = await readSession(api, sessionID, directory)
  return info ? "idle" : "not_found"
}

/** Server truth for every tracked session: status + pending per directory, then absent ones by id. */
export async function readSnapshot(api: OpencodeApi, tracked: Array<{ sessionID: string; directory: string }>): Promise<Map<string, SnapshotEntry>> {
  const directories = [...new Set(tracked.map((t) => t.directory))]
  const reads = new Map(await Promise.all(directories.map(async (d) => [d, await readDirectory(api, d)] as const)))
  const out = new Map<string, SnapshotEntry>()
  await Promise.all(
    tracked.map(async ({ sessionID, directory }) => {
      const read = reads.get(directory)
      if (!read) return
      const live = read.status.get(sessionID)
      const pending = read.pending.get(sessionID) ?? []
      const base = live?.base ?? (await resolveAbsent(api, sessionID, directory))
      out.set(sessionID, { base, detail: live?.detail, pending })
    }),
  )
  return out
}

export type Remote = { directory: string; entry: SnapshotEntry }

/**
 * One session straight from the server. Without a directory (untracked id), the session's own
 * directory comes from GET /session/:id; status is always read in the session's own directory,
 * because a wrong-directory status read would show it absent (and so falsely idle).
 */
export async function readRemote(api: OpencodeApi, sessionID: string, directory?: string): Promise<Remote> {
  let dir = directory
  if (dir === undefined) {
    const info = await readSession(api, sessionID)
    if (!info) return { directory: "", entry: { base: "not_found", pending: [] } }
    dir = info.directory ?? ""
  }
  const read = await readDirectory(api, dir)
  const pending = read.pending.get(sessionID) ?? []
  const live = read.status.get(sessionID)
  if (live) return { directory: dir, entry: { base: live.base, detail: live.detail, pending } }
  const info = await readSession(api, sessionID, dir)
  if (!info) return { directory: dir, entry: { base: "not_found", pending: [] } }
  if (info.directory && info.directory !== dir) return readRemote(api, sessionID, info.directory)
  return { directory: dir, entry: { base: "idle", pending } }
}
