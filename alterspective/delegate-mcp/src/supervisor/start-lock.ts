// MOD-01: serialise box start/stop between bridges on this host (review A-01, A-19).
// The lock file holds the holder's token, PID and process start time. The holder refreshes
// the file's mtime while it works. A waiter takes the lock over only when the holder's PID is
// dead or reused, or when the heartbeat stopped for staleMs. It waits while the holder is
// alive and working, up to waitMs (longer than the slowest image build + health wait).
// Take-over and release both move the file aside under a unique name first, then check what
// they moved, so two waiters can never both delete the same lock.
import { randomUUID } from "node:crypto"
import { DelegateError } from "../shared/errors.ts"
import type { LeaseFs } from "./leases.ts"
import { recordGone, type ProcessProbe, type ProcessRecord } from "./process.ts"

export type Every = (fn: () => void, ms: number) => () => void

export type LockOptions = {
  now: () => number
  sleep: (ms: number) => Promise<void>
  probe: ProcessProbe
  self: ProcessRecord
  /** Heartbeat age after which a live-looking holder is treated as hung. */
  staleMs?: number
  /** Give up waiting for a live holder after this long. */
  waitMs?: number
  heartbeatMs?: number
  every?: Every
}

export const LOCK_STALE_MS = 5 * 60_000
/** ≥ 20 min compose build/up + 2 min health wait + margin (A-01). */
export const LOCK_WAIT_MS = 30 * 60_000
const LOCK_HEARTBEAT_MS = 30_000

export const intervalEvery: Every = (fn, ms) => {
  const timer = setInterval(fn, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}

type Holder = { raw: string; token?: string; record?: ProcessRecord }

function parseHolder(raw: string): Holder {
  try {
    const value = JSON.parse(raw) as { token?: unknown; pid?: unknown; startedAt?: unknown }
    const token = typeof value.token === "string" ? value.token : undefined
    const record = typeof value.pid === "number" ? { pid: value.pid, startedAt: typeof value.startedAt === "number" ? value.startedAt : undefined } : undefined
    return { raw, token, record }
  } catch {
    // Empty (being written right now) or the Wave 1 format: judged by mtime only.
    return { raw }
  }
}

async function holderGone(fs: LeaseFs, lockFile: string, holder: Holder, options: LockOptions): Promise<boolean> {
  const mtime = await fs.mtime(lockFile)
  if (mtime !== undefined && options.now() - mtime > (options.staleMs ?? LOCK_STALE_MS)) return true
  return holder.record ? recordGone(holder.record, options.probe) : false
}

/** Move the lock aside and delete it only if it is still the one we judged (or own). */
async function removeIf(fs: LeaseFs, lockFile: string, expectRaw: (raw: string) => boolean): Promise<boolean> {
  const aside = `${lockFile}.${randomUUID()}.aside`
  if (!(await fs.rename(lockFile, aside))) return false
  const moved = (await fs.read(aside)) ?? ""
  // Not what we expected (someone else re-took it in between): put it back if the slot is free.
  if (!expectRaw(moved)) await fs.write(lockFile, moved, true)
  await fs.remove(aside)
  return expectRaw(moved)
}

async function acquire(fs: LeaseFs, lockFile: string, token: string, options: LockOptions): Promise<void> {
  const deadline = options.now() + (options.waitMs ?? LOCK_WAIT_MS)
  const mine = JSON.stringify({ token, pid: options.self.pid, startedAt: options.self.startedAt, at: new Date(options.now()).toISOString() })
  while (!(await fs.write(lockFile, mine, true))) {
    const raw = await fs.read(lockFile)
    if (raw === undefined) continue
    const holder = parseHolder(raw)
    if (await holderGone(fs, lockFile, holder, options)) {
      await removeIf(fs, lockFile, (moved) => moved === raw)
      continue
    }
    if (options.now() > deadline)
      throw new DelegateError(
        "sandbox_unavailable",
        "Another bridge on this computer is still starting or stopping the sandbox.",
        "Wait for it to finish, then retry. Run oc_doctor if this repeats.",
        `start lock held by pid ${holder.record?.pid ?? "unknown"} for over ${Math.round((options.waitMs ?? LOCK_WAIT_MS) / 60_000)} min`,
      )
    await options.sleep(500)
  }
}

export async function withStartLock<T>(fs: LeaseFs, lockFile: string, run: () => Promise<T>, options: LockOptions): Promise<T> {
  const token = randomUUID()
  await acquire(fs, lockFile, token, options)
  const stop = (options.every ?? intervalEvery)(() => void fs.touch(lockFile), options.heartbeatMs ?? LOCK_HEARTBEAT_MS)
  try {
    return await run()
  } finally {
    stop()
    await removeIf(fs, lockFile, (moved) => parseHolder(moved).token === token)
  }
}
