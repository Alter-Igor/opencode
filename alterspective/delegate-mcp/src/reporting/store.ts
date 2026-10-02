// #73: the task record store, host-side in the bridge's host state folder (<home>/workspaces/reports,
// never mounted in the box). One JSON file per task (<key>.json), so bridges sharing the folder never
// race on one file; each write is a whole file (temp file, then rename), and a Windows EPERM/EBUSY on
// the rename is retried a few times (seen in inbox-sidecar/src/store.ts). Each read-modify-write
// holds a per-key lock file, so two processes of one bridge name do not lose updates. Retention (age,
// then a count cap that open tasks are exempt from) runs when a new task is recorded and before a report. AILES-056: retention decides on
// every file first and deletes after. Nothing here throws to a caller: a failed write is logged
// once (the error code only, no path or content) and otherwise ignored.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
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

export type ReportStoreOptions = {
  dir: string
  rename?: (from: string, to: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Called once per store, with an error code, on the first failed write. */
  warn?: (code: string) => void
  maxAgeDays?: number
  maxRecords?: number
  lockAttempts?: number
  lockRetryMs?: number
  staleLockMs?: number
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
}

const errno = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === "string" && /^[A-Z0-9_]{1,20}$/.test(code) ? code : "unknown"
}

export function createReportStore(options: ReportStoreOptions): ReportStore {
  const dir = options.dir
  const rename = options.rename ?? renameSync
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

  /**
   * Review cycle 1 (LOW 3): a cross-process lock per key (<key>.json.lock, created O_EXCL), so two
   * bridge processes with the same name cannot lose each other's read-modify-write. A lock older than
   * STALE_LOCK_MS is a crashed writer's and is taken over. Undefined when it stays busy: the caller
   * skips the update rather than wait longer.
   */
  async function lock(key: string): Promise<(() => void) | undefined> {
    const file = `${fileOf(key)}.lock`
    mkdirSync(dir, { recursive: true })
    for (let attempt = 1; attempt <= lockAttempts; attempt++) {
      try {
        closeSync(openSync(file, "wx"))
        return () => {
          try {
            unlinkSync(file)
          } catch {
            // already removed (taken over as stale): nothing to release
          }
        }
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error
      }
      let age = 0
      try {
        age = Date.now() - statSync(file).mtimeMs
      } catch {
        continue // released meanwhile: try again at once
      }
      if (age > staleLockMs) {
        try {
          unlinkSync(file)
        } catch {
          // another process took it over first
        }
        continue
      }
      if (attempt < lockAttempts) await sleep(lockRetryMs)
    }
    return undefined
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
      let removed = 0
      for (const file of [...drop, ...staleTmp]) {
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

  return { dir, get, update, list, prune }
}
