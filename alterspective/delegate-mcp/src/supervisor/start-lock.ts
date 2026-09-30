// MOD-01: serialise box start/stop between bridges on this host (review A-01, A-19).
// The lock file holds the holder's token, PID and process start time. The holder refreshes
// the file's mtime while it works. A waiter takes the lock over only when the holder's PID is
// dead or reused, or when the heartbeat stopped for staleMs. It waits while the holder is
// alive and working, up to waitMs (longer than the slowest image build + health wait).
//
// Removing a lock someone else may still own (review N-3): take-over and release both run under
// a short-lived guard file (<lock>.guard, created exclusively). Under the guard the lock is read
// again and removed only if it is still exactly what was judged (or, on release, still ours).
// While one party holds the guard nobody else can remove the lock, and nobody can create a new
// one because the old one still exists, so the read-then-remove cannot delete a lock that
// another bridge has just taken: there is never a second holder, and nothing is ever put back.
// A guard is held for milliseconds; one older than GUARD_STALE_MS was left by a crash and is
// cleared.
//
// Waiting never spins (review N-2): a lock that cannot be read is waited on like a live one, with
// the same sleep and deadline. The holder's start time is read at most once per PID and wait,
// and only when its heartbeat looks late (review N-6).
import { randomUUID } from "node:crypto"
import { DelegateError } from "../shared/errors.ts"
import type { LeaseFs } from "./leases.ts"
import { cachedProbe, recordGone, type ProcessProbe, type ProcessRecord } from "./process.ts"

export type Every = (fn: () => void, ms: number) => () => void

export type LockOptions = {
  now: () => number
  sleep: (ms: number) => Promise<void>
  probe: ProcessProbe
  self: ProcessRecord
  /** Heartbeat age after which a live-looking holder is treated as hung. */
  staleMs?: number
  /** Heartbeat age after which the holder's PID start time is checked (PID reuse). */
  probeAfterMs?: number
  /** Give up waiting for a live holder after this long. */
  waitMs?: number
  heartbeatMs?: number
  every?: Every
}

export const LOCK_STALE_MS = 5 * 60_000
/** ≥ 20 min compose build/up + 2 min health wait + margin (A-01). */
export const LOCK_WAIT_MS = 30 * 60_000
const LOCK_HEARTBEAT_MS = 30_000
/** Two missed heartbeats: only then is the holder's start time read (N-6). */
export const LOCK_PROBE_AFTER_MS = 2 * LOCK_HEARTBEAT_MS
export const GUARD_STALE_MS = 30_000
/** Guard attempts before a guard is treated as stale even if its mtime cannot be judged (frozen clock). */
const GUARD_MAX_ATTEMPTS = 2_000
const POLL_MS = 500
const GUARD_POLL_MS = 15

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

async function holderGone(fs: LeaseFs, lockFile: string, holder: Holder, options: LockOptions, probe: ProcessProbe): Promise<boolean> {
  const mtime = await fs.mtime(lockFile)
  const age = mtime === undefined ? 0 : options.now() - mtime
  if (age > (options.staleMs ?? LOCK_STALE_MS)) return true
  if (!holder.record) return false
  // A dead PID is cheap to see and ends the wait at once; the start time is only read once the
  // heartbeat is late (a working holder touches the file every LOCK_HEARTBEAT_MS).
  if (!Number.isInteger(holder.record.pid) || holder.record.pid <= 0 || !probe.alive(holder.record.pid)) return true
  if (age <= (options.probeAfterMs ?? LOCK_PROBE_AFTER_MS)) return false
  return recordGone(holder.record, probe)
}

/** Run `fn` holding <lock>.guard (see the header). Never runs two `fn`s at once for one lock. */
async function withGuard<T>(fs: LeaseFs, lockFile: string, options: LockOptions, fn: () => Promise<T>): Promise<T> {
  const guard = `${lockFile}.guard`
  const mine = JSON.stringify({ pid: options.self.pid, at: new Date(options.now()).toISOString() })
  let attempts = 0
  while (!(await fs.write(guard, mine, true))) {
    const mtime = await fs.mtime(guard)
    if (mtime !== undefined && options.now() - mtime > GUARD_STALE_MS) {
      await fs.remove(guard) // left by a crash mid take-over
      continue
    }
    if (++attempts >= GUARD_MAX_ATTEMPTS) {
      // Not there, yet it cannot be created: a lasting file-system problem, not a race.
      if (mtime === undefined)
        throw new DelegateError("sandbox_unavailable", "The bridge could not take its start-lock guard.", "Check the bridge home folder (OPENCODE_DELEGATE_HOME) is writable, then run oc_doctor.", `guard create kept failing: ${guard}`)
      await fs.remove(guard) // held far too long without its clock moving: treat as stale
      attempts = 0
      continue
    }
    await options.sleep(GUARD_POLL_MS)
  }
  try {
    return await fn()
  } finally {
    await fs.remove(guard)
  }
}

function waitedTooLong(holder: Holder | undefined, options: LockOptions): DelegateError {
  return new DelegateError(
    "sandbox_unavailable",
    "Another bridge on this computer is still starting or stopping the sandbox.",
    "Wait for it to finish, then retry. Run oc_doctor if this repeats.",
    `start lock ${holder ? `held by pid ${holder.record?.pid ?? "unknown"}` : "unreadable"} for over ${Math.round((options.waitMs ?? LOCK_WAIT_MS) / 60_000)} min`,
  )
}

async function acquire(fs: LeaseFs, lockFile: string, token: string, options: LockOptions): Promise<void> {
  const deadline = options.now() + (options.waitMs ?? LOCK_WAIT_MS)
  const probe = cachedProbe(options.probe)
  const mine = JSON.stringify({ token, pid: options.self.pid, startedAt: options.self.startedAt, at: new Date(options.now()).toISOString() })
  while (!(await fs.write(lockFile, mine, true))) {
    const raw = await fs.read(lockFile)
    const holder = raw === undefined ? undefined : parseHolder(raw)
    if (holder && (await holderGone(fs, lockFile, holder, options, probe))) {
      await withGuard(fs, lockFile, options, async () => {
        // Still the lock we judged? Then nobody else owns it yet (N-3).
        if ((await fs.read(lockFile)) === holder.raw) await fs.remove(lockFile)
      })
      continue
    }
    // A live holder, or a lock that cannot be read right now (N-2): wait, never spin.
    if (options.now() > deadline) throw waitedTooLong(holder, options)
    await options.sleep(POLL_MS)
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
    await withGuard(fs, lockFile, options, async () => {
      const raw = await fs.read(lockFile)
      // Taken over while we worked (we were judged hung): leave the new holder's lock alone.
      if (raw !== undefined && parseHolder(raw).token === token) await fs.remove(lockFile)
    })
  }
}
