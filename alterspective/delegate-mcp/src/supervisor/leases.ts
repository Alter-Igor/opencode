// MOD-01 T1.3: bridge leases on the one shared box (technical-design.md §4 "Stop").
// One file per bridge under <home>/leases. The box stops only when the last live lease goes.
// Leases whose process is gone (crashed bridge) are pruned so they cannot pin the box forever.
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

export type LeaseFs = {
  list(dir: string): Promise<string[]>
  read(file: string): Promise<string | undefined>
  /** exclusive=true must fail if the file exists (used for the start lock). */
  write(file: string, text: string, exclusive?: boolean): Promise<boolean>
  remove(file: string): Promise<void>
  /** Modification time in ms, or undefined when missing. */
  mtime(file: string): Promise<number | undefined>
}

export type Leases = {
  acquire(bridgeId: string, pid: number): Promise<void>
  /** Remove this bridge's lease; returns how many live leases remain. */
  release(bridgeId: string): Promise<number>
  active(): Promise<string[]>
}

const BRIDGE_ID = /^[A-Za-z0-9_-]{1,64}$/

export function assertBridgeId(bridgeId: string): void {
  if (!BRIDGE_ID.test(bridgeId)) throw new Error("invalid bridge id")
}

export function createLeases(fs: LeaseFs, dir: string, isAlive: (pid: number) => boolean): Leases {
  const file = (id: string) => path.join(dir, id)
  async function active(): Promise<string[]> {
    const live: string[] = []
    for (const id of await fs.list(dir)) {
      if (!BRIDGE_ID.test(id)) continue
      const pid = Number((await fs.read(file(id)))?.split("\n")[0])
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) live.push(id)
      else await fs.remove(file(id))
    }
    return live.sort()
  }
  return {
    active,
    async acquire(bridgeId, pid) {
      assertBridgeId(bridgeId)
      await fs.write(file(bridgeId), `${pid}\n${new Date().toISOString()}\n`)
    },
    async release(bridgeId) {
      assertBridgeId(bridgeId)
      await fs.remove(file(bridgeId))
      return (await active()).length
    },
  }
}

/** Serialise box start-up between bridges on this host. A lock older than staleMs is taken over. */
export async function withStartLock<T>(
  fs: LeaseFs,
  lockFile: string,
  run: () => Promise<T>,
  options: { now: () => number; sleep: (ms: number) => Promise<void>; staleMs?: number; waitMs?: number },
): Promise<T> {
  const staleMs = options.staleMs ?? 5 * 60_000
  const deadline = options.now() + (options.waitMs ?? 6 * 60_000)
  while (!(await fs.write(lockFile, String(options.now()), true))) {
    const mtime = await fs.mtime(lockFile)
    if (mtime !== undefined && options.now() - mtime > staleMs) await fs.remove(lockFile)
    else if (options.now() > deadline) throw new Error("timed out waiting for the start lock")
    else await options.sleep(500)
  }
  try {
    return await run()
  } finally {
    await fs.remove(lockFile)
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export const nodeLeaseFs: LeaseFs = {
  list: (dir) => readdir(dir).catch(() => []),
  read: (file) => readFile(file, "utf8").catch(() => undefined),
  async write(file, text, exclusive = false) {
    await mkdir(path.dirname(file), { recursive: true })
    try {
      await writeFile(file, text, { encoding: "utf8", flag: exclusive ? "wx" : "w" })
      return true
    } catch (error) {
      if (exclusive && (error as NodeJS.ErrnoException).code === "EEXIST") return false
      throw error
    }
  },
  remove: (file) => rm(file, { force: true }),
  mtime: (file) => stat(file).then((s) => s.mtimeMs, () => undefined),
}
