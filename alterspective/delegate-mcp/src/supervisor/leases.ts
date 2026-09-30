// MOD-01 T1.3: bridge leases on the one shared box (technical-design.md §4 "Stop").
// One file per bridge under <home>/leases. The box stops only when the last live lease goes.
// A lease records the bridge PID and process start time, and its mtime is a heartbeat the
// bridge refreshes every minute (review A-18/A-19). A lease is dropped when its PID is dead,
// or when its heartbeat is old AND the PID now belongs to a different process (PID reuse).
import { randomBytes } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import { DelegateError } from "../shared/errors.ts"
import { recordGone, type ProcessProbe, type ProcessRecord } from "./process.ts"

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
const LEASE_STALE_MS = 5 * 60_000
const BRIDGE_ID = /^[A-Za-z0-9_-]{1,64}$/

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
  const staleMs = options.staleMs ?? LEASE_STALE_MS
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

async function renameRetry(from: string, to: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
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
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
      throw error
    }
  },
  remove: (file) => rm(file, { force: true }),
  mtime: (file) => stat(file).then((s) => s.mtimeMs, () => undefined),
  touch: (file) => utimes(file, new Date(), new Date()).then(() => true, () => false),
  rename: renameRetry,
}
