// MOD-01: is a recorded process still the same process? Used by leases and the start lock
// (review A-18/A-19). A PID alone can be reused after a crash, so records also keep the
// process start time; a record is only trusted when both still match.
import { bunExec, type Exec } from "./docker.ts"

/** Records whose start times differ by less than this are the same process (clock/rounding slack). */
const START_SLACK_MS = 5_000

export type ProcessProbe = {
  /** True when a process with this PID exists (EPERM counts as existing). */
  alive(pid: number): boolean
  /** Start time of the PID in epoch ms, or undefined when it cannot be read. */
  startTime(pid: number): Promise<number | undefined>
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Windows FILETIME (100 ns ticks since 1601) → epoch ms. */
export function fileTimeToMs(text: string): number | undefined {
  if (!/^\d{15,20}$/.test(text.trim())) return undefined
  return Number(BigInt(text.trim()) / 10_000n) - 11_644_473_600_000
}

/** Start time of any PID via the OS (PowerShell on Windows, ps elsewhere). */
export async function osStartTime(pid: number, exec: Exec = bunExec): Promise<number | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  if (process.platform === "win32") {
    const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`
    const result = await exec(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { env: windowsEnv(), timeoutMs: 15_000 })
    return result.code === 0 ? fileTimeToMs(result.stdout) : undefined
  }
  const result = await exec(["ps", "-o", "lstart=", "-p", String(pid)], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" }, timeoutMs: 15_000 })
  const ms = result.code === 0 ? Date.parse(result.stdout.trim()) : Number.NaN
  return Number.isFinite(ms) ? ms : undefined
}

function windowsEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ["SystemRoot", "PATH", "Path", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "windir", "ComSpec"]) {
    const value = process.env[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

/** This process's own start time, read the same way other bridges will read it. */
export async function ownStartTime(probe: ProcessProbe): Promise<number> {
  return (await probe.startTime(process.pid)) ?? Math.round(Date.now() - process.uptime() * 1000)
}

export type ProcessRecord = { pid: number; startedAt?: number }

/**
 * Is the recorded process gone? Dead PID → gone. Live PID with a different start time → the
 * PID was reused → gone. If the start time cannot be read, the record is kept (fail safe:
 * keeping the box up is better than stopping it under a live bridge).
 */
export async function recordGone(record: ProcessRecord, probe: ProcessProbe): Promise<boolean> {
  if (!Number.isInteger(record.pid) || record.pid <= 0) return true
  if (!probe.alive(record.pid)) return true
  if (record.startedAt === undefined) return false
  const actual = await probe.startTime(record.pid)
  return actual !== undefined && Math.abs(actual - record.startedAt) > START_SLACK_MS
}

export const nodeProcessProbe: ProcessProbe = { alive: processAlive, startTime: (pid) => osStartTime(pid) }

/**
 * `probe` with start times remembered per PID (review N-6). A live process's start time cannot
 * change, and reading it costs a PowerShell or ps run, so a waiter asks once per PID. Use one
 * cache per wait: if the PID dies and is reused during that wait, the cached value can hide the
 * reuse, and the heartbeat's staleness rule (LOCK_STALE_MS) still ends the wait.
 */
export function cachedProbe(probe: ProcessProbe): ProcessProbe {
  const starts = new Map<number, Promise<number | undefined>>()
  return {
    alive: (pid) => probe.alive(pid),
    startTime(pid) {
      let start = starts.get(pid)
      if (!start) {
        start = probe.startTime(pid).catch(() => undefined)
        starts.set(pid, start)
      }
      return start
    },
  }
}
