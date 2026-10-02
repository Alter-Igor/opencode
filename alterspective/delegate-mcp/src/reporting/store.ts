// #73: the task record store, host-side in the bridge's host state folder (<home>/workspaces/reports,
// never mounted in the box). One JSON file per task (<key>.json), so bridges sharing the folder never
// race on one file; each write is a whole file (temp file, then rename), and a Windows EPERM/EBUSY on
// the rename is retried a few times (seen in inbox-sidecar/src/store.ts). Each read-modify-write
// holds a per-key lock file, so two processes of one bridge name do not lose updates. Retention (age,
// then a count cap that open tasks are exempt from) runs when a new task is recorded and before a report. AILES-056: retention decides on
// every file first and deletes after. Nothing here throws to a caller: a failed write is logged
// once (the error code only, no path or content) and otherwise ignored.
import { randomBytes } from "node:crypto"
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import path from "node:path"
import { SESSION_KEY } from "../supervisor/workspaces-state.ts"
import { parseTaskRecord, type TaskRecord } from "./record.ts"

export const REPORT_MAX_AGE_DAYS = 90
export const REPORT_MAX_RECORDS = 2000
/** Rename attempts (the first plus retries) and the wait before each retry. */
const RENAME_ATTEMPTS = 5
const RENAME_BACKOFF_MS = [20, 40, 80, 160]
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"])
/** Retention on write runs at most this often per process (a report always runs it). */
const PRUNE_EVERY_MS = 10 * 60 * 1000
/** Temp files a crashed writer left behind are removed after this long. */
const STALE_TMP_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** Per-key lock: tries, the wait between them (about 0.5 s in all), and when a held lock is a crashed writer's. */
const LOCK_ATTEMPTS = 20
const LOCK_RETRY_MS = 25
export const STALE_LOCK_MS = 10_000
/** A lock dated further ahead than this is from a skewed clock (a fresh one can read a few ms ahead). */
const FUTURE_TOLERANCE_MS = 1_000

export type ReportStoreOptions = {
  dir: string
  rename?: (from: string, to: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Called once per store, with an error code, on the first failed write. */
  warn?: (code: string, fields?: { key: string; errno: string }) => void
  /** Test seam: the hard link used to put back a live lock moved aside. */
  link?: (existing: string, created: string) => void
  maxAgeDays?: number
  maxRecords?: number
  lockAttempts?: number
  lockRetryMs?: number
  staleLockMs?: number
  /** Test seam: awaited after a stale lock is seen and before it is taken over. */
  onStaleLock?: () => Promise<void>
}

export type ReportStore = {
  readonly dir: string
  get(key: string): TaskRecord | undefined
  /**
   * Read the task's record, apply `fn`, write the result whole. `fn` returning undefined writes
   * nothing. Updates of one key run one after another. Resolves to what was saved; never rejects.
   */
  update(key: string, fn: (current: TaskRecord | undefined) => TaskRecord | undefined): Promise<TaskRecord | undefined>
  /** Every valid record (damaged or foreign files are skipped). */
  list(): TaskRecord[]
  /** Apply retention now; returns how many records were removed. Never throws. */
  prune(): number
  /** Wait for every queued update to finish (tests, shutdown). Never rejects. */
  flush(): Promise<void>
}

const errno = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === "string" && /^[A-Z0-9_]{1,20}$/.test(code) ? code : "unknown"
}

export function createReportStore(options: ReportStoreOptions): ReportStore {
  const dir = options.dir
  const rename = options.rename ?? renameSync
  const link = options.link ?? linkSync
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const maxAgeMs = (options.maxAgeDays ?? REPORT_MAX_AGE_DAYS) * DAY_MS
  const maxRecords = options.maxRecords ?? REPORT_MAX_RECORDS
  const lockAttempts = options.lockAttempts ?? LOCK_ATTEMPTS
  const lockRetryMs = options.lockRetryMs ?? LOCK_RETRY_MS
  const staleLockMs = options.staleLockMs ?? STALE_LOCK_MS
  const chains = new Map<string, Promise<unknown>>()
  let warned = false
  let lastPrune = Number.NEGATIVE_INFINITY
  let tmpSerial = 0

  const fileOf = (key: string) => path.join(dir, `${key}.json`)

  function warnOnce(code: string): void {
    if (warned) return
    warned = true
    try {
      options.warn?.(code)
    } catch {
      // a broken log sink must not matter
    }
  }

  /** Cycle 3: a failed link-back, logged once per store, separately from failed writes. */
  let relinkWarned = false
  function warnRelinkOnce(key: string, error: unknown): void {
    if (relinkWarned) return
    relinkWarned = true
    try {
      options.warn?.("lock_relink_failed", { key, errno: errno(error) })
    } catch {
      // a broken log sink must not matter
    }
  }

  function get(key: string): TaskRecord | undefined {
    if (!SESSION_KEY.test(key)) return undefined
    try {
      const record = parseTaskRecord(readFileSync(fileOf(key), "utf8"))
      return record?.key === key ? record : undefined
    } catch {
      return undefined
    }
  }

  async function renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        rename(from, to)
        return
      } catch (error) {
        if (attempt >= RENAME_ATTEMPTS || !RETRY_CODES.has(errno(error))) throw error
        await sleep(RENAME_BACKOFF_MS[attempt - 1] ?? 160)
      }
    }
  }

  async function write(record: TaskRecord): Promise<void> {
    const file = fileOf(record.key)
    const tmp = `${file}.${process.pid}.${++tmpSerial}.tmp`
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(record))
    try {
      await renameWithRetry(tmp, file)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        // already gone
      }
      throw error
    }
  }

  async function apply(key: string, fn: (current: TaskRecord | undefined) => TaskRecord | undefined): Promise<TaskRecord | undefined> {
    if (!SESSION_KEY.test(key)) {
      warnOnce("invalid_key")
      return undefined
    }
    let release: (() => void) | undefined
    let current: TaskRecord | undefined
    let next: TaskRecord | undefined
    try {
      release = await lock(key)
      if (!release) {
        warnOnce("lock_busy")
        return undefined
      }
      current = get(key)
      next = fn(current)
      if (!next || next.key !== key) return undefined
      await write(next)
    } catch (error) {
      warnOnce(errno(error))
      return undefined
    } finally {
      release?.()
    }
    if (!current && now() - lastPrune >= PRUNE_EVERY_MS) prune()
    return next
  }

  /** Review cycle 2 (LOW 2): older than the timeout, or dated in the future (a lock from a skewed clock). */
  const isStale = (file: string): boolean => {
    const age = Date.now() - statSync(file).mtimeMs
    return age > staleLockMs || age < -FUTURE_TOLERANCE_MS
  }

  /**
   * Review cycles 1-2 (LOW 3): a cross-process lock per key (<key>.json.lock, created O_EXCL and
   * holding a random owner token), so two bridge processes with the same name cannot lose each
   * other's read-modify-write. A stale lock (a crashed writer's) is taken over atomically: it is
   * renamed aside to a unique name, which only one taker can do; if what was moved turns out to be a
   * fresh lock (someone else took over first), it is linked back (never over another lock). The new
   * lock is then created with O_EXCL like any other. Release deletes the lock only while it still
   * holds this owner's token. Undefined when it stays busy: the caller skips the update.
   */
  async function lock(key: string): Promise<(() => void) | undefined> {
    const file = `${fileOf(key)}.lock`
    const token = randomBytes(12).toString("hex")
    mkdirSync(dir, { recursive: true })
    for (let attempt = 1; attempt <= lockAttempts; attempt++) {
      try {
        const fd = openSync(file, "wx")
        try {
          writeSync(fd, token)
        } finally {
          closeSync(fd)
        }
        return () => {
          try {
            if (readFileSync(file, "utf8") === token) unlinkSync(file)
          } catch {
            // already gone: nothing to release
          }
        }
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error
      }
      let stale: boolean
      try {
        stale = isStale(file)
      } catch {
        continue // released meanwhile: try again at once
      }
      if (stale) {
        await options.onStaleLock?.()
        const aside = `${file}.${token}.${attempt}.stale`
        try {
          renameSync(file, aside)
        } catch {
          continue // another taker moved it first
        }
        let live = false
        try {
          live = !isStale(aside)
        } catch {
          // the moved file is gone: nothing to put back
        }
        if (live) {
          try {
            link(aside, file) // a live lock was moved: put it back, never over another lock
          } catch (error) {
            // Accepted limit for a metrics store: when the link-back fails (EEXIST: a new lock already
            // stands there; or no hard links, e.g. FAT), the moved lock's owner and the next taker can
            // both write in a rare window. The worst case is one lost count, never lost data (each
            // write is a whole, valid file). Logged once with the key and error code only.
            warnRelinkOnce(key, error)
          }
        }
        try {
          unlinkSync(aside)
        } catch {
          // left for retention
        }
        continue
      }
      if (attempt < lockAttempts) await sleep(lockRetryMs)
    }
    return undefined
  }

  /** Review cycle 2 (LOW 1): resolves once every queued update (of every key) has finished. */
  async function flush(): Promise<void> {
    while (chains.size) await Promise.all([...chains.values()])
  }

  function update(key: string, fn: (current: TaskRecord | undefined) => TaskRecord | undefined): Promise<TaskRecord | undefined> {
    const previous = chains.get(key) ?? Promise.resolve()
    const run = previous.then(() => apply(key, fn)).catch((error: unknown) => {
      warnOnce(errno(error))
      return undefined
    })
    chains.set(key, run)
    void run.finally(() => {
      if (chains.get(key) === run) chains.delete(key)
    })
    return run
  }

  function names(): string[] {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }

  function list(): TaskRecord[] {
    const out: TaskRecord[] = []
    for (const name of names()) {
      if (!name.endsWith(".json") || !SESSION_KEY.test(name.slice(0, -5))) continue
      const record = get(name.slice(0, -5))
      if (record) out.push(record)
    }
    return out
  }

  function prune(): number {
    lastPrune = now()
    try {
      // Pass 1: decide on every file. Pass 2: delete.
      const cutoff = now() - maxAgeMs
      const records = list().sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      const old = records.filter((r) => Date.parse(r.startedAt) < cutoff)
      // Review cycle 1 (LOW 4): open tasks never count towards the cap (their work is still out there).
      const overCap = records.filter((r) => Date.parse(r.startedAt) >= cutoff && r.disposition !== "open").slice(maxRecords)
      const drop = [...old, ...overCap].map((r) => fileOf(r.key))
      const staleTmp = names()
        .filter((n) => n.endsWith(".tmp"))
        .map((n) => path.join(dir, n))
        .filter((file) => {
          try {
            return Date.now() - statSync(file).mtimeMs > STALE_TMP_MS
          } catch {
            return false
          }
        })
      // Review cycle 2 (LOW 4): a stale lock with no record left (and a taken-over lock set aside).
      const staleLocks = names()
        .filter((n) => (n.endsWith(".json.lock") && !existsSync(path.join(dir, n.slice(0, -".lock".length)))) || n.endsWith(".stale"))
        .map((n) => path.join(dir, n))
        .filter((file) => {
          try {
            return isStale(file)
          } catch {
            return false
          }
        })
      let removed = 0
      for (const file of [...drop, ...staleTmp, ...staleLocks]) {
        try {
          unlinkSync(file)
          if (file.endsWith(".json")) removed++
        } catch {
          // another bridge removed it first, or it is locked: the next prune tries again
        }
      }
      return removed
    } catch {
      return 0
    }
  }

  return { dir, get, update, list, prune, flush }
}
