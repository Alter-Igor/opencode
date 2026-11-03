// MOD-01 T1.3: bridge leases on the one shared box (technical-design.md §4 "Stop").
// One file per bridge under <home>/leases. The box stops only when the last live lease goes.
// A lease records the bridge PID and process start time, and its mtime is a heartbeat the
// bridge refreshes every minute (review A-18/A-19). A lease is dropped when its PID is dead,
// or when its heartbeat is old AND the PID now belongs to a different process (PID reuse).
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import { PROJECT_RE } from "../shared/config.ts"
import { DelegateError } from "../shared/errors.ts"
import { readGenerations } from "./generations.ts"
import { nodeProcessProbe, recordGone, type ProcessProbe, type ProcessRecord } from "./process.ts"

export type LeaseFs = {
  list(dir: string): Promise<string[]>
  read(file: string): Promise<string | undefined>
  /** exclusive=true returns false if the file exists (start lock). Otherwise the write is atomic (tmp + rename). */
  write(file: string, text: string, exclusive?: boolean): Promise<boolean>
  remove(file: string): Promise<void>
  /** Modification time in ms, or undefined when missing. */
  mtime(file: string): Promise<number | undefined>
  /** Set mtime to now; false when the file is missing. */
  touch(file: string): Promise<boolean>
  /** Atomic rename; false when the source is missing. */
  rename(from: string, to: string): Promise<boolean>
}

export type Leases = {
  acquire(bridgeId: string, self: ProcessRecord): Promise<void>
  /** Refresh this bridge's heartbeat; false when the lease file is gone (caller re-acquires). */
  heartbeat(bridgeId: string): Promise<boolean>
  /** Remove this bridge's lease; returns how many live leases remain. */
  release(bridgeId: string): Promise<number>
  active(): Promise<string[]>
}

export type LeaseOptions = { probe: ProcessProbe; now: () => number; staleMs?: number }

export const LEASE_HEARTBEAT_MS = 60_000
/** #265: a dead-PID or corrupt lease file is unlinked only after its heartbeat/mtime is older than 60s. */
export const LEASE_STALE_MS = 60_000
const PID_REUSE_STALE_MS = 5 * 60_000
const BRIDGE_ID = /^[A-Za-z0-9_-]{1,64}$/

export type SweepLeaseEntry = {
  id: string
  bridgeId: string
  supervisor?: string
  generation?: string
  pid?: number
  alive?: boolean
  unknown?: boolean
  heartbeat: string
  idleSec?: number
  updatedAt?: string
}

export type SweepLeasesOptions = {
  probe?: Pick<ProcessProbe, "alive">
  now?: () => number
  staleMs?: number
  readOnly?: boolean
}

export type SweepLeasesResult = {
  leases: SweepLeaseEntry[]
  activeSupervisors: Set<string>
  pruned: number
}

export function assertBridgeId(bridgeId: string): void {
  if (!BRIDGE_ID.test(bridgeId))
    throw new DelegateError("invalid_input", "The bridge id is not valid.", "Restart the bridge.", "bridge id must match [A-Za-z0-9_-]{1,64}")
}

/** JSON record, or the Wave 1 format "pid\nISO time\n" (still read so a running box is not orphaned). */
export function parseRecord(text: string | undefined): ProcessRecord | undefined {
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as { pid?: unknown; startedAt?: unknown }
    if (typeof value.pid === "number") return { pid: value.pid, startedAt: typeof value.startedAt === "number" ? value.startedAt : undefined }
  } catch {
    // fall through to the legacy format
  }
  const pid = Number(text.split("\n")[0])
  return Number.isInteger(pid) && pid > 0 ? { pid } : undefined
}

export function createLeases(fs: LeaseFs, dir: string, options: LeaseOptions): Leases {
  const file = (id: string) => path.join(dir, id)
  const staleMs = options.staleMs ?? PID_REUSE_STALE_MS
  async function isLive(id: string): Promise<boolean> {
    const record = parseRecord(await fs.read(file(id)))
    if (!record || !options.probe.alive(record.pid)) return false
    const mtime = await fs.mtime(file(id))
    if (mtime !== undefined && options.now() - mtime <= staleMs) return true
    return !(await recordGone(record, options.probe))
  }
  async function active(): Promise<string[]> {
    const live: string[] = []
    for (const id of await fs.list(dir)) {
      if (!BRIDGE_ID.test(id)) continue
      if (await isLive(id)) live.push(id)
      else await fs.remove(file(id))
    }
    return live.sort()
  }
  return {
    active,
    async acquire(bridgeId, self) {
      assertBridgeId(bridgeId)
      await fs.write(file(bridgeId), JSON.stringify({ pid: self.pid, startedAt: self.startedAt, bridgeId, at: new Date(options.now()).toISOString() }) + "\n")
    },
    async heartbeat(bridgeId) {
      assertBridgeId(bridgeId)
      return fs.touch(file(bridgeId))
    },
    async release(bridgeId) {
      assertBridgeId(bridgeId)
      await fs.remove(file(bridgeId))
      return (await active()).length
    },
  }
}

type ParsedLeaseFile = {
  valid: boolean
  id: string
  bridgeId: string
  supervisor?: string
  pid?: number
  updatedAt?: string
}

function parseLeaseFile(text: string, fallbackName: string): ParsedLeaseFile {
  try {
    const raw = JSON.parse(text) as unknown
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>
      const pid = typeof obj.pid === "number" && Number.isInteger(obj.pid) && obj.pid > 0 ? obj.pid : undefined
      if (pid !== undefined) {
        const id = typeof obj.id === "string" && obj.id ? obj.id : typeof obj.bridgeId === "string" && obj.bridgeId ? obj.bridgeId : fallbackName
        const bridgeId = typeof obj.bridgeId === "string" && obj.bridgeId ? obj.bridgeId : id
        const supervisor = typeof obj.supervisor === "string" && obj.supervisor ? obj.supervisor : undefined
        const updatedAt = typeof obj.updatedAt === "string" && obj.updatedAt ? obj.updatedAt : undefined
        return { valid: true, id, bridgeId, ...(supervisor ? { supervisor } : {}), pid, ...(updatedAt ? { updatedAt } : {}) }
      }
      return { valid: false, id: fallbackName, bridgeId: fallbackName }
    }
  } catch {
    // check legacy format below
  }
  const legacy = parseRecord(text)
  if (legacy) return { valid: true, id: fallbackName, bridgeId: fallbackName, pid: legacy.pid }
  return { valid: false, id: fallbackName, bridgeId: fallbackName }
}

async function discoverLeaseDirs(home: string): Promise<Array<{ dir: string; generation?: string }>> {
  const seen = new Set<string>()
  const out: Array<{ dir: string; generation?: string }> = []
  const add = (dir: string, generation?: string) => {
    const key = path.resolve(dir)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ dir, ...(generation ? { generation } : {}) })
  }
  add(path.join(home, "leases"))
  const recorded = await readGenerations(home)
  for (const gen of recorded) add(path.join(home, "generations", gen, "leases"), gen)
  const genBase = path.join(home, "generations")
  const entries = await readdir(genBase, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROJECT_RE.test(entry.name)) continue
    add(path.join(genBase, entry.name, "leases"), entry.name)
  }
  return out
}

/**
 * #265: Enumerate and sweep lease files across `<home>/leases` and all `<home>/generations/<gen>/leases`.
 * Dead leases (`!probe.alive(pid)`) and corrupt JSON files older than `LEASE_STALE_MS` (60s) are unlinked.
 * Corrupt JSON that is still fresh (`<= LEASE_STALE_MS`) is kept as `unknown` and never treated as dead.
 */
export async function sweepAllLeases(home: string, options: SweepLeasesOptions = {}): Promise<SweepLeasesResult> {
  const now = (options.now ?? Date.now)()
  const staleMs = options.staleMs ?? LEASE_STALE_MS
  const probe = options.probe ?? nodeProcessProbe
  const dirs = await discoverLeaseDirs(home)
  const activeLeases: SweepLeaseEntry[] = []
  let pruned = 0

  for (const { dir, generation } of dirs) {
    const names = (await readdir(dir).catch(() => []))
      .filter((name) => BRIDGE_ID.test(name.replace(/\.json$/i, "")))
      .sort()
    for (const name of names) {
      const stem = name.replace(/\.json$/i, "")
      const file = path.join(dir, name)
      const [text, st] = await Promise.all([readFile(file, "utf8").catch(() => undefined), stat(file).catch(() => undefined)])
      if (text === undefined || st === undefined) continue
      const mtimeMs = st.mtimeMs
      const parsed = parseLeaseFile(text, stem)
      if (!parsed.valid || parsed.pid === undefined) {
        if (now - mtimeMs > staleMs) {
          if (!options.readOnly) {
            await rm(file, { force: true })
            pruned++
          }
          continue
        }
        activeLeases.push({
          id: stem,
          bridgeId: stem,
          ...(generation ? { generation } : {}),
          unknown: true,
          heartbeat: new Date(mtimeMs).toISOString(),
          idleSec: Math.max(0, Math.floor((now - mtimeMs) / 1000)),
        })
        continue
      }
      const alive = probe.alive(parsed.pid)
      const updatedMs = parsed.updatedAt ? Date.parse(parsed.updatedAt) : 0
      const lastMs = Math.max(Number.isFinite(updatedMs) ? updatedMs : 0, mtimeMs)
      if (!alive && now - lastMs > staleMs && !options.readOnly) {
        await rm(file, { force: true })
        pruned++
        continue
      }
      activeLeases.push({
        id: parsed.id,
        bridgeId: parsed.bridgeId,
        ...(parsed.supervisor ? { supervisor: parsed.supervisor } : {}),
        ...(generation ? { generation } : {}),
        pid: parsed.pid,
        alive,
        ...(parsed.updatedAt ? { updatedAt: parsed.updatedAt } : {}),
        heartbeat: new Date(lastMs).toISOString(),
        idleSec: Math.max(0, Math.floor((now - lastMs) / 1000)),
      })
    }
  }

  activeLeases.sort((a, b) => (a.idleSec ?? Number.MAX_SAFE_INTEGER) - (b.idleSec ?? Number.MAX_SAFE_INTEGER))
  const activeSupervisors = new Set(activeLeases.filter((l) => l.alive !== false || (l.idleSec ?? 0) * 1000 <= staleMs).map((l) => l.id))
  return { leases: activeLeases, activeSupervisors, pruned }
}

export const listAllLeases = sweepAllLeases

/** Whether a session record's `supervisor` (`supervisor:<name>` or `<id>`) matches any live lease in `activeSupervisors`. */
export function isSupervisorActive(supervisor: string | undefined, activeSupervisors: ReadonlySet<string>): boolean {
  if (!supervisor) return false
  if (activeSupervisors.has(supervisor)) return true
  const short = supervisor.replace(/^supervisor:/, "")
  if (activeSupervisors.has(short) || activeSupervisors.has(`supervisor:${short}`)) return true
  for (const raw of activeSupervisors) {
    const id = raw.replace(/^supervisor:/, "")
    if (id === short || id.startsWith(`${short}-`)) return true
  }
  return false
}

/** True when `<home>` has a leases folder or generations folder on disk (i.e. lease tracking is present). */
export function hasLeaseTracking(home: string): boolean {
  return existsSync(path.join(home, "leases")) || existsSync(path.join(home, "generations")) || existsSync(path.join(home, "generations.json"))
}

/** A raw rename (fs.promises.rename by default; tests pass a fake). */
export type RawRename = (from: string, to: string) => Promise<void>

/**
 * Rename, retrying EPERM/EBUSY/EACCES a few times (Windows holds a just-written file open for a
 * moment: indexer, antivirus). false when the source is missing; any other error is thrown.
 */
export async function renameRetry(from: string, to: string, raw: RawRename = rename): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await raw(from, to)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") return false
      // Windows refuses to replace a file another process has open for a moment.
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  try {
    await writeFile(tmp, text, "utf8")
    await renameRetry(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
}

export const nodeLeaseFs: LeaseFs = {
  list: (dir) => readdir(dir).catch(() => []),
  read: (file) => readFile(file, "utf8").catch(() => undefined),
  async write(file, text, exclusive = false) {
    await mkdir(path.dirname(file), { recursive: true })
    if (!exclusive) return atomicWrite(file, text).then(() => true)
    try {
      await writeFile(file, text, { encoding: "utf8", flag: "wx" })
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "EEXIST") return false
      // Windows: creating a name whose previous file is still being deleted fails with EPERM
      // (delete pending) for a moment. That is "taken right now": the caller waits and retries.
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) return false
      throw error
    }
  },
  remove: (file) => rm(file, { force: true }),
  mtime: (file) => stat(file).then((s) => s.mtimeMs, () => undefined),
  touch: (file) => utimes(file, new Date(), new Date()).then(() => true, () => false),
  rename: (from, to) => renameRetry(from, to),
}
