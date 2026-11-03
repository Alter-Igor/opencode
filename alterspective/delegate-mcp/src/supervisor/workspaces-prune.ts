// #53: API deletion does not mean the clone is gone. Keep its host recovery record until both are absent.
import { existsSync, linkSync, lstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { hasLeaseTracking, isSupervisorActive, sweepAllLeases } from "./leases.ts"
import { parseHostState, SESSION_KEY, SUPERVISOR_RE, type HostSessionState } from "./workspaces-state.ts"
import type { Exec } from "./workspaces-exec.ts"

export type BoundHostState = HostSessionState & { sessionID: string }
export type MissingSession = (state: BoundHostState, timeoutMs: number) => Promise<boolean>

export type PruneOptions = {
  /** Live supervisor/bridge IDs from `sweepAllLeases`. Records of dead supervisors become eligible. */
  activeSupervisors?: ReadonlySet<string>
  /** Active turn check: never prune a session with an active turn. */
  hasActiveTurn?: (sessionID: string) => boolean
  /** Live session IDs in the box: never prune if still present here. */
  liveSessionIds?: ReadonlySet<string>
  /** Check whether a non-current generation box container is still running. */
  isBoxRunning?: (boxProject: string) => Promise<boolean> | boolean
}

const PAGE_NAMES = 100
const PAGE_SESSIONS = 20
const PAGE_MS = 5_000
const PROBE_MS = 1_000
// Distinct exit codes avoid treating a docker/exec failure as proof of absence. Keep dangling links.
/** ABSENT_CLONE_PROBE exit codes: clone absent, clone (or a link) present, sessions folder unreadable. */
export const PROBE_ABSENT = 44
export const PROBE_PRESENT = 45
export const PROBE_UNREADABLE = 46
export const ABSENT_CLONE_PROBE = 'if [ ! -d "$2" ] || [ ! -r "$2" ] || [ ! -x "$2" ]; then exit 46; fi; if [ -e "$1" ] || [ -L "$1" ]; then exit 45; fi; exit 44'

export function snapshotRecord(file: string) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) return
  const raw = readFileSync(file, "utf8")
  const after = lstatSync(file)
  if (!after.isFile() || after.isSymbolicLink() || stat.ino !== after.ino || stat.dev !== after.dev || stat.ctimeMs !== after.ctimeMs || stat.mtimeMs !== after.mtimeMs || stat.size !== after.size) return
  return { raw, stat: after }
}

type RecordSnapshot = NonNullable<ReturnType<typeof snapshotRecord>>

/** Same bytes and same file. ctime is left out: a rename changes it on Linux. */
function sameRecord(a: RecordSnapshot, b: RecordSnapshot): boolean {
  return a.raw === b.raw && a.stat.ino === b.stat.ino && a.stat.dev === b.stat.dev && a.stat.mtimeMs === b.stat.mtimeMs && a.stat.size === b.stat.size
}

function present(file: string): boolean {
  try {
    lstatSync(file)
    return true
  } catch {
    return false
  }
}

/** Put a moved record back without replacing one written since. If a newer record holds the name, the moved copy stays beside it for the owner. */
function restore(moved: string, file: string): void {
  try {
    linkSync(moved, file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" || present(file)) return
    // No hard links on this filesystem: move it back while the name is still free.
    renameSync(moved, file)
    return
  }
  unlinkSync(moved)
}

/**
 * Delete `file` only if it is still exactly `expected`. It is first moved to a name no writer uses and
 * checked there: a writer that replaced the record after the first check (writeHostState renames a
 * new file over the name) is caught and its record put back. `beforeMove` is a test hook.
 */
export function removeUnchanged(file: string, expected: RecordSnapshot, beforeMove?: () => void): boolean {
  const current = snapshotRecord(file)
  if (!current || !sameRecord(current, expected) || current.stat.ctimeMs !== expected.stat.ctimeMs) return false
  beforeMove?.()
  const moved = `${file}.${randomUUID()}.pruning`
  // Another bridge that already removed it makes this throw; the sweep then counts nothing as removed.
  renameSync(file, moved)
  let taken: RecordSnapshot | undefined
  try {
    taken = snapshotRecord(moved)
  } catch {
    taken = undefined
  }
  if (taken && sameRecord(taken, expected)) {
    unlinkSync(moved)
    return true
  }
  restore(moved, file)
  return false
}

function readCursor(file: string): string {
  try {
    const cursor = snapshotRecord(file)?.raw ?? ""
    return SESSION_KEY.test(cursor.replace(/\.json$/, "")) && cursor.endsWith(".json") ? cursor : ""
  } catch {
    return ""
  }
}

export type SessionPrunerDeps = {
  stateDir: string
  boxSessions: string
  box: Exec
  host?: Exec
  home?: string
  boxProject: string
  timeoutMs: number
  isBoxRunning?: (boxProject: string) => Promise<boolean> | boolean
}

async function defaultBoxRunning(deps: SessionPrunerDeps, project: string): Promise<boolean> {
  if (deps.isBoxRunning) return deps.isBoxRunning(project)
  if (!deps.host) return true
  const res = await deps.host(["docker", "inspect", "-f", "{{.State.Running}}", project], { timeoutMs: PROBE_MS }).catch(() => undefined)
  if (!res) return true
  if (res.code !== 0 && /no such object|no such container/i.test(res.stderr)) return false
  if (res.code === 0 && res.stdout.trim() === "false") return false
  return true
}

/** Each page reads <=100 records and checks <=20 sessions; a persisted filename cursor reaches old records. */
export function createSessionPruner(options: SessionPrunerDeps) {
  const pending = new Map<string, Promise<string[]>>()
  async function sweep(
    supervisor: string,
    missing: MissingSession,
    tracked: (sessionID: string) => boolean,
    pruneOptions?: PruneOptions,
  ): Promise<string[]> {
    if (!SUPERVISOR_RE.test(supervisor)) return []
    const names = readdirSync(options.stateDir).filter((name) => name.endsWith(".json") && SESSION_KEY.test(name.slice(0, -5))).sort()
    if (!names.length) return []

    const home = options.home ?? path.dirname(options.stateDir)
    let activeSupervisors = pruneOptions?.activeSupervisors
    if (activeSupervisors === undefined && hasLeaseTracking(home)) {
      const swept = await sweepAllLeases(home).catch(() => undefined)
      activeSupervisors = swept?.activeSupervisors
    }
    const orphanSweepEnabled = activeSupervisors !== undefined || pruneOptions !== undefined
    const boxRunningCache = new Map<string, boolean>()
    const checkBoxRunning = async (project: string): Promise<boolean> => {
      const cached = boxRunningCache.get(project)
      if (cached !== undefined) return cached
      const running = pruneOptions?.isBoxRunning ? await pruneOptions.isBoxRunning(project) : await defaultBoxRunning(options, project)
      boxRunningCache.set(project, running)
      return running
    }

    const cursorFile = path.join(options.stateDir, `.prune-${supervisor.slice("supervisor:".length)}.cursor`)
    const cursor = readCursor(cursorFile)
    const start = names.findIndex((name) => name > cursor)
    const ordered = start < 0 ? names : [...names.slice(start), ...names.slice(0, start)]
    const removed: string[] = []
    const deadline = Date.now() + PAGE_MS
    let checked = 0
    let last = cursor
    const currentBoxProject = options.boxProject

    for (const name of ordered.slice(0, PAGE_NAMES)) {
      if (checked >= PAGE_SESSIONS || Date.now() >= deadline) break
      last = name
      try {
        const file = path.join(options.stateDir, name)
        const before = snapshotRecord(file)
        if (!before) continue
        const state = parseHostState(before.raw, name.slice(0, -5))
        if (!state?.sessionID) continue

        const isOwnSupervisor = state.supervisor === supervisor
        const isOrphanSupervisor =
          orphanSweepEnabled &&
          (!state.supervisor || (activeSupervisors !== undefined && !isSupervisorActive(state.supervisor, activeSupervisors)))
        if (!isOwnSupervisor && !isOrphanSupervisor) continue

        const isCurrentBox = state.boxProject === currentBoxProject
        const isLegacyBox = orphanSweepEnabled && !state.boxProject
        let isRetiredBox = false
        if (!isCurrentBox && !isLegacyBox && orphanSweepEnabled && state.boxProject) {
          isRetiredBox = !(await checkBoxRunning(state.boxProject))
        }
        if (!isCurrentBox && !isLegacyBox && !isRetiredBox) continue

        const liveId = state.boxSessionID ?? state.sessionID
        const isProtected =
          tracked(state.sessionID) ||
          pruneOptions?.hasActiveTurn?.(state.sessionID) === true ||
          pruneOptions?.liveSessionIds?.has(state.sessionID) === true ||
          pruneOptions?.liveSessionIds?.has(liveId) === true
        if (isProtected) continue

        checked++
        if (!(await missing({ ...state, sessionID: state.sessionID }, Math.max(1, Math.min(PROBE_MS, deadline - Date.now()))))) continue
        if (Date.now() >= deadline) continue

        let cloneConfirmedGone = false
        if (isRetiredBox && !existsSync(state.hostRepo)) {
          cloneConfirmedGone = true
        } else {
          const result = await options.box(["sh", "-c", ABSENT_CLONE_PROBE, "sh", `${options.boxSessions}/${state.sessionKey}`, options.boxSessions], {
            timeoutMs: Math.max(1, Math.min(options.timeoutMs, PROBE_MS, deadline - Date.now())),
          })
          cloneConfirmedGone = !result.timedOut && result.code === PROBE_ABSENT && !result.stdout.trim() && !result.stderr.trim()
        }
        if (!cloneConfirmedGone) continue

        if (tracked(state.sessionID) || pruneOptions?.hasActiveTurn?.(state.sessionID) === true) continue
        if (removeUnchanged(file, before)) removed.push(state.sessionKey)
      } catch {
        // A damaged record, uncertain API/box read, or concurrent replacement is left for a later page.
      }
    }
    const tmp = `${cursorFile}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmp, last, { flag: "wx" })
      renameSync(tmp, cursorFile)
    } catch {
      // Cursor persistence is best effort; keep the result of records already removed.
    } finally {
      try { unlinkSync(tmp) } catch { /* renamed or already absent */ }
    }
    return removed
  }
  return (
    supervisor: string,
    missing: MissingSession,
    tracked: (sessionID: string) => boolean = () => false,
    pruneOptions?: PruneOptions,
  ): Promise<string[]> => {
    const active = pending.get(supervisor)
    if (active) return active
    const run = sweep(supervisor, missing, tracked, pruneOptions).finally(() => pending.delete(supervisor))
    pending.set(supervisor, run)
    return run
  }
}

export const pruneDeletedBoxSessions = createSessionPruner
