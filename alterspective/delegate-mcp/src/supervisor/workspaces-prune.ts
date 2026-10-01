// #53: API deletion does not mean the clone is gone. Keep its host recovery record until both are absent.
import { lstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { parseHostState, SESSION_KEY, SUPERVISOR_RE, type HostSessionState } from "./workspaces-state.ts"
import type { Exec } from "./workspaces-exec.ts"

export type BoundHostState = HostSessionState & { sessionID: string }
export type MissingSession = (state: BoundHostState, timeoutMs: number) => Promise<boolean>
const PAGE_NAMES = 100
const PAGE_SESSIONS = 20
const PAGE_MS = 5_000
const PROBE_MS = 1_000
// Distinct exit codes avoid treating a docker/exec failure as proof of absence. Keep dangling links.
export const ABSENT_CLONE_PROBE = 'if [ ! -d "$2" ] || [ ! -r "$2" ] || [ ! -x "$2" ]; then exit 46; fi; if [ -e "$1" ] || [ -L "$1" ]; then exit 45; fi; exit 44'

function snapshot(file: string) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) return
  const raw = readFileSync(file, "utf8")
  const after = lstatSync(file)
  if (!after.isFile() || after.isSymbolicLink() || stat.ino !== after.ino || stat.dev !== after.dev || stat.ctimeMs !== after.ctimeMs || stat.mtimeMs !== after.mtimeMs || stat.size !== after.size) return
  return { raw, stat: after }
}

function removeUnchanged(file: string, expected: NonNullable<ReturnType<typeof snapshot>>): boolean {
  const current = snapshot(file)
  if (!current || current.raw !== expected.raw || current.stat.ino !== expected.stat.ino || current.stat.dev !== expected.stat.dev || current.stat.ctimeMs !== expected.stat.ctimeMs || current.stat.mtimeMs !== expected.stat.mtimeMs) return false
  // No await between the final re-read and unlink. Another bridge that already removed it is harmless.
  unlinkSync(file)
  return true
}

function readCursor(file: string): string {
  try {
    const cursor = snapshot(file)?.raw ?? ""
    return SESSION_KEY.test(cursor.replace(/\.json$/, "")) && cursor.endsWith(".json") ? cursor : ""
  } catch {
    return ""
  }
}

/** Each page reads <=100 records and checks <=20 sessions; a persisted filename cursor reaches old records. */
export function createSessionPruner(options: { stateDir: string; boxSessions: string; box: Exec; timeoutMs: number }) {
  const pending = new Map<string, Promise<string[]>>()
  async function sweep(supervisor: string, missing: MissingSession): Promise<string[]> {
    if (!SUPERVISOR_RE.test(supervisor)) return []
    const names = readdirSync(options.stateDir).filter((name) => name.endsWith(".json") && SESSION_KEY.test(name.slice(0, -5))).sort()
    if (!names.length) return []
    const cursorFile = path.join(options.stateDir, `.prune-${supervisor.slice("supervisor:".length)}.cursor`)
    const cursor = readCursor(cursorFile)
    const start = names.findIndex((name) => name > cursor)
    const ordered = start < 0 ? names : [...names.slice(start), ...names.slice(0, start)]
    const removed: string[] = []
    const deadline = Date.now() + PAGE_MS
    let checked = 0
    let last = cursor
    for (const name of ordered.slice(0, PAGE_NAMES)) {
      if (checked >= PAGE_SESSIONS || Date.now() >= deadline) break
      last = name
      try {
        const file = path.join(options.stateDir, name)
        const before = snapshot(file)
        if (!before) continue
        const state = parseHostState(before.raw, name.slice(0, -5))
        if (!state?.sessionID || state.supervisor !== supervisor) continue
        checked++
        if (!(await missing({ ...state, sessionID: state.sessionID }, Math.max(1, Math.min(PROBE_MS, deadline - Date.now()))))) continue
        if (Date.now() >= deadline) continue
        const result = await options.box(["sh", "-c", ABSENT_CLONE_PROBE, "sh", `${options.boxSessions}/${state.sessionKey}`, options.boxSessions], { timeoutMs: Math.max(1, Math.min(options.timeoutMs, PROBE_MS, deadline - Date.now())) })
        if (result.timedOut || result.code !== 44 || result.stdout.trim() || result.stderr.trim()) continue
        if (removeUnchanged(file, before)) removed.push(state.sessionKey)
      } catch {
        // A damaged record, uncertain API/box read, or concurrent replacement is left for a later page.
      }
    }
    const tmp = `${cursorFile}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmp, last, { flag: "wx" })
      renameSync(tmp, cursorFile)
    } finally {
      try { unlinkSync(tmp) } catch { /* renamed or already absent */ }
    }
    return removed
  }
  return (supervisor: string, missing: MissingSession): Promise<string[]> => {
    const active = pending.get(supervisor)
    if (active) return active
    const run = sweep(supervisor, missing).finally(() => pending.delete(supervisor))
    pending.set(supervisor, run)
    return run
  }
}
