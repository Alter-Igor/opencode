// MOD-03 T3.3: read session state from the server (reconnect rebuild and view()).
// Idle sessions are ABSENT from GET /session/status (session/status.ts:42-46), and so are deleted
// and wrong-directory sessions, so absence is resolved with GET /session/:id: 200 in the same
// directory → idle, 200 in another directory → re-read there, 404 → not_found. Pending requests
// come from GET /permission and GET /question; running sessions' subagents from
// GET /session/:id/children. There is no event replay, so this read is the only truth after a gap.
// Each directory and each session is read on its own (allSettled): one failure leaves only those
// sessions unknown, with the reason, instead of failing the whole rebuild (W2A-09).
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { expectOk, type OpencodeApi } from "../shared/opencode-api.ts"
import { REQUEST_ID_RE, isObj } from "./normalise.ts"
import type { PendingKind, SnapshotEntry, Tracked } from "./state.ts"

type StatusMap = Map<string, { base: "busy" | "retry"; detail?: string }>
type PendingMap = Map<string, Array<{ requestID: string; kind: PendingKind }>>
type DirectoryRead = { status: StatusMap; pending: PendingMap }

/** At most this many server reads in flight during a rebuild (W2A-22). */
export const READ_CONCURRENCY = 8

const enc = encodeURIComponent

/** Run `fn` over `items` with at most `limit` in flight; never rejects. */
export async function settleAll<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const out: Array<PromiseSettledResult<R>> = []
  const queue = items.map((item, index) => ({ item, index }))
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        out[job.index] = { status: "fulfilled", value: await fn(job.item) }
      } catch (reason) {
        out[job.index] = { status: "rejected", reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** A short, bridge-side reason for a failed read (error codes and HTTP statuses only). */
export function reason(error: unknown): string {
  return isDelegateError(error) ? `${error.code}${error.detail ? ` ${error.detail}` : ""}` : "unexpected error"
}

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
    if (!isObj(item) || typeof item.id !== "string" || typeof item.sessionID !== "string" || !REQUEST_ID_RE.test(item.id)) continue
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

export type SessionInfo = { id: string; directory?: string; parentID?: string }

function sessionInfo(data: unknown): SessionInfo | undefined {
  if (!isObj(data) || typeof data.id !== "string") return undefined
  return { id: data.id, directory: typeof data.directory === "string" ? data.directory : undefined, parentID: typeof data.parentID === "string" ? data.parentID : undefined }
}

/** GET /session/:id → info, or undefined on 404. Any other failure throws. */
export async function readSession(api: OpencodeApi, sessionID: string, directory?: string): Promise<SessionInfo | undefined> {
  const res = await api.call<unknown>({ path: `/session/${enc(sessionID)}`, directory })
  if (res.status === 404) return undefined
  const info = sessionInfo(expectOk(res, "read the session"))
  if (!info) throw new DelegateError("upstream_error", "The delegate server returned an unexpected session.", "Retry; if it repeats, run oc_doctor.")
  return info
}

/** GET /session/:id/children → the subagent sessions (W2A-03). */
export async function readChildren(api: OpencodeApi, sessionID: string, directory: string): Promise<Tracked[]> {
  const data = expectOk(await api.call<unknown>({ path: `/session/${enc(sessionID)}/children`, directory }), "list subagent sessions")
  if (!Array.isArray(data)) return []
  return data.flatMap((item) => {
    const info = sessionInfo(item)
    return info ? [{ sessionID: info.id, directory: info.directory ?? directory }] : []
  })
}

/** Absent from the status read: idle only if the session really lives in that directory (W2A-08). */
async function resolveAbsent(api: OpencodeApi, sessionID: string, directory: string, pending: SnapshotEntry["pending"]): Promise<SnapshotEntry> {
  const info = await readSession(api, sessionID, directory)
  if (!info) return { base: "not_found", pending: [] }
  if (info.directory && info.directory !== directory) {
    const remote = await readRemote(api, sessionID, info.directory)
    return { ...remote.entry, directory: remote.directory }
  }
  return { base: "idle", pending }
}

export type Child = Tracked & { parentID: string }
export type Snapshot = {
  entries: Map<string, SnapshotEntry>
  /** sessionID → why it could not be read (it stays unknown). */
  failed: Map<string, string>
  /** Subagent sessions of running tracked sessions that were not tracked yet. */
  children: Child[]
}

async function readDirectories(api: OpencodeApi, directories: string[], into: Map<string, DirectoryRead | string>): Promise<void> {
  const todo = directories.filter((d) => !into.has(d))
  const results = await settleAll(todo, READ_CONCURRENCY, (d) => readDirectory(api, d))
  todo.forEach((d, i) => {
    const r = results[i]
    into.set(d, r?.status === "fulfilled" ? r.value : `could not read directory state (${reason(r?.reason)})`)
  })
}

/** Children of every tracked session that the status read shows running. */
async function discoverChildren(api: OpencodeApi, tracked: Tracked[], reads: Map<string, DirectoryRead | string>, known: (id: string) => boolean): Promise<Child[]> {
  const running = tracked.filter((t) => {
    const read = reads.get(t.directory)
    return typeof read === "object" && read.status.has(t.sessionID)
  })
  const results = await settleAll(running, READ_CONCURRENCY, (t) => readChildren(api, t.sessionID, t.directory))
  const found = new Map<string, Child>()
  running.forEach((parent, i) => {
    const r = results[i]
    if (r?.status !== "fulfilled") return // a failed list: the child's own events still track it
    for (const c of r.value) if (!known(c.sessionID) && !found.has(c.sessionID)) found.set(c.sessionID, { ...c, parentID: parent.sessionID })
  })
  return [...found.values()]
}

async function readOne(api: OpencodeApi, t: Tracked, read: DirectoryRead): Promise<SnapshotEntry> {
  const live = read.status.get(t.sessionID)
  const pending = read.pending.get(t.sessionID) ?? []
  if (live) return { base: live.base, detail: live.detail, pending }
  return resolveAbsent(api, t.sessionID, t.directory, pending)
}

/** Server truth for `tracked` (and newly found subagents): status + pending per directory, then absent ones by id. */
export async function readSnapshot(api: OpencodeApi, tracked: Tracked[], known: (id: string) => boolean = () => false): Promise<Snapshot> {
  const reads = new Map<string, DirectoryRead | string>()
  await readDirectories(api, [...new Set(tracked.map((t) => t.directory))], reads)
  const children = await discoverChildren(api, tracked, reads, known)
  await readDirectories(api, [...new Set(children.map((c) => c.directory))], reads)
  const snapshot: Snapshot = { entries: new Map(), failed: new Map(), children }
  const jobs: Array<{ t: Tracked; read: DirectoryRead }> = []
  for (const t of [...tracked, ...children]) {
    const read = reads.get(t.directory)
    if (typeof read === "object") jobs.push({ t, read })
    else snapshot.failed.set(t.sessionID, read ?? "directory not read")
  }
  const results = await settleAll(jobs, READ_CONCURRENCY, (j) => readOne(api, j.t, j.read))
  jobs.forEach(({ t }, i) => {
    const r = results[i]
    if (r?.status === "fulfilled") snapshot.entries.set(t.sessionID, r.value)
    else snapshot.failed.set(t.sessionID, `could not read the session (${reason(r?.reason)})`)
  })
  return snapshot
}

export type Remote = { directory: string; entry: SnapshotEntry }

/**
 * One session straight from the server. Without a directory (untracked id), the session's own
 * directory comes from GET /session/:id; status is always read in the session's own directory,
 * because a wrong-directory status read would show it absent (and so falsely idle).
 */
export async function readRemote(api: OpencodeApi, sessionID: string, directory?: string, depth = 0): Promise<Remote> {
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
  if (info.directory && info.directory !== dir) {
    if (depth > 0) throw new DelegateError("upstream_error", "The delegate server reported the session in two directories.", "Retry; if it repeats, run oc_doctor.")
    return readRemote(api, sessionID, info.directory, depth + 1)
  }
  return { directory: dir, entry: { base: "idle", pending } }
}
