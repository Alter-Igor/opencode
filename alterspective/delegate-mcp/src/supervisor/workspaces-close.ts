// #72: close a finished session — its OpenCode session, its box clone (/sessions/<key>), its host
// record and, when asked, the host branch delegate/<key>. Order (review cycle 1, AILES-056):
//   1. check (reads only): a refusal here changes nothing;
//   2. stop the session (the caller's hook: refuse or abort a running one);
//   3. check again, now that nothing writes the clone: a refusal still deletes nothing and
//      oc_collect keeps working, because the OpenCode session still exists;
//   4. delete the session, then (unless discardWork) a last check catches work that slipped in;
//   5. remove the clone, the branch, the record; the first failure stops there and keeps the record.
// Data-loss guards: commits in the clone (refs, HEAD and reflogs) that no host branch contains, and
// uncommitted files, are refused unless discardWork. Git-ignored files are counted and reported only.
// The host branch goes only when another host branch contains it (never HEAD alone, never a
// symbolic ref, never when checked out), unless discardWork; the delete is a --no-deref
// compare-and-delete of that one ref. Only records of this bridge, this box and this session id.
import { readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import type { Exec } from "./workspaces-exec.ts"
import { ABSENT_CLONE_PROBE, PROBE_ABSENT, PROBE_PRESENT, removeUnchanged, snapshotRecord } from "./workspaces-prune.ts"
import { COMMIT_ID, parseHostState, SESSION_KEY, SUPERVISOR_RE, type HostSessionState } from "./workspaces-state.ts"

/** Most refs read from one clone; a clone with more is not inspected (check_failed). */
const MAX_TIPS = 50
/** Record names read per closeCandidates call (a persisted cursor continues from the last one). */
const MAX_SCAN = 100

export type CloseOwner = { supervisor: string; sessionID: string }
export type CloseOptions = { discardWork: boolean; deleteBranch: boolean }
/** What deleting the OpenCode session did; a failure is thrown. */
export type SessionRemoval = "deleted" | "already_gone"
/** `stop` makes sure nothing writes the clone any more (or throws); `deleteSession` removes the OpenCode session. */
export type CloseHooks = { stop: () => Promise<void>; deleteSession: () => Promise<SessionRemoval> }
export type BranchPlan = "not_requested" | "absent" | "merged" | "unmerged" | "checked_out" | "symbolic" | "unknown"
export type CloseRefusal = "uncollected_work" | "check_failed"

type Counts = { uncollectedCommits: number; uncommittedPaths: number; ignoredPaths: number }

export type ClosePlan = Counts & {
  sessionKey: string
  sessionID: string
  clone: "present" | "absent" | "unknown"
  /** Nothing would be lost and every check could be made. */
  safe: boolean
  reason?: CloseRefusal
  branch: BranchPlan
}

export type CloseOutcome = Counts & {
  sessionKey: string
  sessionID: string
  /** Session, clone and record are all gone. */
  closed: boolean
  refused?: CloseRefusal
  session: SessionRemoval | "kept"
  clone: "removed" | "absent" | "kept" | "failed"
  branch: "not_requested" | "absent" | "deleted" | "kept_unmerged" | "kept_checked_out" | "kept_symbolic" | "kept_unknown" | "failed"
  record: "removed" | "kept"
}

export type CloseDeps = {
  stateDir: string
  boxSessions: string
  boxProject: string
  host: Exec
  box: Exec
  timeoutMs: number
  /** Paths the bridge itself writes into clones (WORKSPACE_EXCLUDES): never counted. */
  excludes: readonly string[]
  /** The owner repo, re-checked against the allowed roots (workspaces.resolveRepo). */
  resolveRepo: (hostRepo: string) => Promise<string>
}

type Owned = { state: HostSessionState & { sessionID: string }; snapshot: NonNullable<ReturnType<typeof snapshotRecord>>; file: string }
type CloneState = Counts & { clone: ClosePlan["clone"]; failed?: boolean }
type BranchState = { plan: BranchPlan; tip?: string; repo?: string }

const notOurs = (key: string) =>
  new DelegateError("not_found", "That session is not one of this bridge's sessions in this sandbox.", "Use oc_list_sessions to see this bridge's sessions.", `close refused: ${key}`)

/** The record, only when it names this session id, this bridge and this box. */
function owned(deps: CloseDeps, key: string, owner: CloseOwner): Owned {
  if (!SESSION_KEY.test(key) || !SUPERVISOR_RE.test(owner.supervisor)) throw notOurs(key)
  const file = path.join(deps.stateDir, `${key}.json`)
  let snapshot: Owned["snapshot"] | undefined
  try {
    snapshot = snapshotRecord(file)
  } catch {
    snapshot = undefined
  }
  const state = snapshot ? parseHostState(snapshot.raw, key) : undefined
  if (!snapshot || !state?.sessionID || state.sessionID !== owner.sessionID || state.supervisor !== owner.supervisor || state.boxProject !== deps.boxProject) throw notOurs(key)
  return { state: { ...state, sessionID: state.sessionID }, snapshot, file }
}

const clonePath = (deps: CloseDeps, key: string) => `${deps.boxSessions}/${key}`

/** Absent, present, or unknown (box down, unreadable sessions folder, any output). */
async function probeClone(deps: CloseDeps, key: string): Promise<ClosePlan["clone"]> {
  const result = await deps.box(["sh", "-c", ABSENT_CLONE_PROBE, "sh", clonePath(deps, key), deps.boxSessions], { timeoutMs: deps.timeoutMs })
  if (result.timedOut || result.stdout.trim() || result.stderr.trim()) return "unknown"
  return result.code === PROBE_ABSENT ? "absent" : result.code === PROBE_PRESENT ? "present" : "unknown"
}

async function boxGit(deps: CloseDeps, key: string, args: string[]) {
  return deps.box(["git", "-C", clonePath(deps, key), ...args], { timeoutMs: deps.timeoutMs })
}

/** Every commit a ref (branch, tag, stash) or HEAD of the clone points at. Undefined when unreadable. */
async function cloneTips(deps: CloseDeps, key: string): Promise<string[] | undefined> {
  const refs = await boxGit(deps, key, ["for-each-ref", "--format=%(objectname) %(*objectname)", "refs/heads", "refs/tags", "refs/stash"])
  const head = await boxGit(deps, key, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
  if (refs.code !== 0 || (head.code !== 0 && head.code !== 1)) return undefined
  const tips = new Set<string>()
  for (const line of [...refs.stdout.split(/\r?\n/), head.stdout]) {
    const [object, peeled] = line.trim().split(" ")
    const tip = peeled || object
    if (!tip) continue
    if (!COMMIT_ID.test(tip)) return undefined
    tips.add(tip)
  }
  return tips.size <= MAX_TIPS ? [...tips] : undefined
}

/** Uncommitted (changed, untracked) and git-ignored paths; `-z`: a rename or copy carries a second path. */
async function worktreeCounts(deps: CloseDeps, key: string): Promise<Pick<Counts, "uncommittedPaths" | "ignoredPaths"> | undefined> {
  const result = await boxGit(deps, key, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"])
  if (result.code !== 0) return undefined
  const entries = result.stdout.split("\u0000")
  const out = { uncommittedPaths: 0, ignoredPaths: 0 }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ""
    if (!entry) continue
    if (/^[RC]/.test(entry)) i++
    if (!entry.startsWith("!! ")) out.uncommittedPaths++
    else if (!deps.excludes.some((prefix) => entry.slice(3).startsWith(prefix))) out.ignoredPaths++
  }
  return out
}

async function hostGit(deps: CloseDeps, repo: string, args: string[]) {
  return deps.host(["git", "-C", repo, ...args], { timeoutMs: deps.timeoutMs })
}

/** Is `commit` on some host branch? undefined when git could not say. */
async function onHostBranch(deps: CloseDeps, repo: string, commit: string): Promise<boolean | undefined> {
  const present = await hostGit(deps, repo, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`])
  if (present.code === 1) return false
  if (present.code !== 0) return undefined
  const contains = await hostGit(deps, repo, ["for-each-ref", "--count=1", "--format=%(refname)", "--contains", commit, "refs/heads/"])
  return contains.code === 0 ? contains.stdout.trim().length > 0 : undefined
}

/** The host's delegate/<key>: absent, symbolic (never followed), its commit, or null when git failed. */
async function hostBranchTip(deps: CloseDeps, repo: string, key: string): Promise<string | "absent" | "symbolic" | null> {
  const ref = `refs/heads/delegate/${key}`
  const symbolic = await hostGit(deps, repo, ["symbolic-ref", "-q", ref])
  if (symbolic.code === 0) return "symbolic"
  if (symbolic.code !== 1) return null
  const result = await hostGit(deps, repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
  if (result.code === 1) return "absent"
  const tip = result.stdout.trim()
  return result.code === 0 && COMMIT_ID.test(tip) ? tip : null
}

const numberOf = (result: { code: number; stdout: string }) => {
  const n = Number(result.stdout.trim())
  return result.code === 0 && Number.isInteger(n) ? n : undefined
}

/** Commits only the clone has: from refs the host lacks, plus reflog-only commits (e.g. after reset --hard). */
async function countLost(deps: CloseDeps, key: string, repo: string, base: string, lost: string[], collected: string[]): Promise<number | undefined> {
  const hostTip = await hostBranchTip(deps, repo, key)
  const known = [base, ...collected]
  if (hostTip && COMMIT_ID.test(hostTip) && (await boxGit(deps, key, ["rev-parse", "--verify", "--quiet", `${hostTip}^{commit}`])).code === 0) known.push(hostTip)
  const fromRefs = lost.length ? numberOf(await boxGit(deps, key, ["rev-list", "--count", ...lost, "--not", ...known])) : 0
  const fromReflogs = numberOf(await boxGit(deps, key, ["rev-list", "--count", "--reflog", "--not", "--all", "HEAD", ...known]))
  return fromRefs === undefined || fromReflogs === undefined ? undefined : fromRefs + fromReflogs
}

const failedClone = (clone: ClosePlan["clone"], tree?: Pick<Counts, "uncommittedPaths" | "ignoredPaths">): CloneState => ({ clone, uncollectedCommits: 0, uncommittedPaths: tree?.uncommittedPaths ?? 0, ignoredPaths: tree?.ignoredPaths ?? 0, failed: true })

/** Which tips no host branch contains (undefined when git could not say). */
async function splitTips(deps: CloseDeps, repo: string, tips: string[]): Promise<{ lost: string[]; collected: string[] } | undefined> {
  const out = { lost: [] as string[], collected: [] as string[] }
  for (const tip of tips) {
    const onHost = await onHostBranch(deps, repo, tip)
    if (onHost === undefined) return undefined
    ;(onHost ? out.collected : out.lost).push(tip)
  }
  return out
}

/** What closing would lose from the clone. Reads only (box git and host git). */
async function inspectClone(deps: CloseDeps, state: HostSessionState): Promise<CloneState> {
  const key = state.sessionKey
  const presence = await probeClone(deps, key)
  if (presence === "absent") return { clone: "absent", uncollectedCommits: 0, uncommittedPaths: 0, ignoredPaths: 0 }
  if (presence === "unknown") return failedClone("unknown")
  const [tips, tree] = [await cloneTips(deps, key), await worktreeCounts(deps, key)]
  if (tips === undefined || tree === undefined) return failedClone("present", tree)
  const reflogOnly = numberOf(await boxGit(deps, key, ["rev-list", "--count", "--reflog", "--not", "--all", "HEAD", state.base]))
  if (reflogOnly === undefined) return failedClone("present", tree)
  const candidates = tips.filter((tip) => tip !== state.base)
  if (!candidates.length && reflogOnly === 0) return { clone: "present", uncollectedCommits: 0, ...tree }
  const repo = await deps.resolveRepo(state.hostRepo).catch(() => undefined)
  const split = repo ? await splitTips(deps, repo, candidates) : undefined
  if (!repo || !split) return failedClone("present", tree)
  if (!split.lost.length && reflogOnly === 0) return { clone: "present", uncollectedCommits: 0, ...tree }
  const count = await countLost(deps, key, repo, state.base, split.lost, split.collected)
  return count === undefined ? failedClone("present", tree) : { clone: "present", uncollectedCommits: count, ...tree }
}

/** Contained by some OTHER real host branch (not delegate/<key>, not a symbolic ref, never HEAD alone). */
async function mergedElsewhere(deps: CloseDeps, repo: string, key: string, tip: string): Promise<boolean | undefined> {
  const result = await hostGit(deps, repo, ["for-each-ref", "--format=%(refname) %(symref)", "--contains", tip, "refs/heads/"])
  if (result.code !== 0) return undefined
  const own = `refs/heads/delegate/${key}`
  return result.stdout.split(/\r?\n/).some((line) => {
    const [ref, symref] = line.trim().split(" ")
    return !!ref && ref !== own && !symref
  })
}

/** Whether delegate/<key> may be deleted: merged into another branch, and checked out nowhere. */
async function inspectBranch(deps: CloseDeps, state: HostSessionState): Promise<BranchState> {
  const repo = await deps.resolveRepo(state.hostRepo).catch(() => undefined)
  if (!repo) return { plan: "unknown" }
  const tip = await hostBranchTip(deps, repo, state.sessionKey)
  if (tip === "absent" || tip === "symbolic") return { plan: tip, repo }
  if (tip === null) return { plan: "unknown", repo }
  const worktrees = await hostGit(deps, repo, ["worktree", "list", "--porcelain"])
  if (worktrees.code !== 0) return { plan: "unknown", repo, tip }
  const ref = `branch refs/heads/delegate/${state.sessionKey}`
  if (worktrees.stdout.split(/\r?\n/).some((line) => line.trim() === ref)) return { plan: "checked_out", repo, tip }
  const merged = await mergedElsewhere(deps, repo, state.sessionKey, tip)
  return { plan: merged === undefined ? "unknown" : merged ? "merged" : "unmerged", repo, tip }
}

const reasonOf = (clone: CloneState): CloseRefusal | undefined =>
  clone.failed ? "check_failed" : clone.uncollectedCommits > 0 || clone.uncommittedPaths > 0 ? "uncollected_work" : undefined

const countsOf = (c: Counts): Counts => ({ uncollectedCommits: c.uncollectedCommits, uncommittedPaths: c.uncommittedPaths, ignoredPaths: c.ignoredPaths })

/** Read-only: what closing would do and lose. */
export async function inspectClose(deps: CloseDeps, key: string, owner: CloseOwner, options: Pick<CloseOptions, "deleteBranch">): Promise<ClosePlan> {
  const o = owned(deps, key, owner)
  const clone = await inspectClone(deps, o.state)
  const branch: BranchPlan = options.deleteBranch ? (await inspectBranch(deps, o.state)).plan : "not_requested"
  const reason = reasonOf(clone)
  return { sessionKey: key, sessionID: o.state.sessionID, clone: clone.clone, ...countsOf(clone), safe: reason === undefined, ...(reason ? { reason } : {}), branch }
}

/** rm the clone (path from the validated key only), then prove it is gone. */
async function removeClone(deps: CloseDeps, key: string): Promise<boolean> {
  const result = await deps.box(["rm", "-rf", "--", clonePath(deps, key)], { timeoutMs: deps.timeoutMs })
  if (result.code !== 0) return false
  return (await probeClone(deps, key)) === "absent"
}

/** --no-deref compare-and-delete of exactly refs/heads/delegate/<key> at the inspected tip; never another ref, never a checkout. */
async function removeBranch(deps: CloseDeps, key: string, branch: BranchState, discardWork: boolean): Promise<CloseOutcome["branch"]> {
  if (branch.plan === "not_requested" || branch.plan === "absent") return branch.plan
  if (branch.plan === "checked_out") return "kept_checked_out"
  if (branch.plan === "symbolic") return "kept_symbolic"
  if (branch.plan === "unknown" || !branch.repo || !branch.tip) return "kept_unknown"
  if (branch.plan === "unmerged" && !discardWork) return "kept_unmerged"
  const result = await hostGit(deps, branch.repo, ["update-ref", "--no-deref", "-d", `refs/heads/delegate/${key}`, branch.tip])
  return result.code === 0 ? "deleted" : "failed"
}

/** Only the record read in the first check, unchanged; one replaced or removed meanwhile (another close) is kept / not counted. */
function removeRecord(o: Owned): boolean {
  try {
    return removeUnchanged(o.file, o.snapshot)
  } catch {
    return false
  }
}

/** A hook failure: a DelegateError passes through; anything else becomes upstream_error. Nothing further is removed. */
async function hook<T>(fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (isDelegateError(error)) throw error
    throw new DelegateError("upstream_error", `The sandbox failed to ${what}; the session's copy and record were kept.`, "Retry oc_close_session; if it repeats, run oc_doctor.", String(error).slice(0, 200))
  }
}

function kept(o: Owned, clone: CloneState, session: CloseOutcome["session"], refused?: CloseRefusal): CloseOutcome {
  return { sessionKey: o.state.sessionKey, sessionID: o.state.sessionID, closed: false, ...(refused ? { refused } : {}), session, clone: "kept", branch: "not_requested", record: "kept", ...countsOf(clone) }
}

/** Close one session (see the order at the top). A refusal before step 4 deletes nothing. */
export async function closeSession(deps: CloseDeps, key: string, owner: CloseOwner, options: CloseOptions, hooks: CloseHooks): Promise<CloseOutcome> {
  const o = owned(deps, key, owner)
  const first = await inspectClone(deps, o.state)
  if (reasonOf(first) && !options.discardWork) return kept(o, first, "kept", reasonOf(first))
  await hook(hooks.stop, "stop the session")
  const stopped = await inspectClone(deps, o.state)
  if (reasonOf(stopped) && !options.discardWork) return kept(o, stopped, "kept", reasonOf(stopped))
  const branch: BranchState = options.deleteBranch ? await inspectBranch(deps, o.state) : { plan: "not_requested" }
  const session = await hook(hooks.deleteSession, "delete the session")
  let final = stopped
  if (!options.discardWork && stopped.clone !== "absent") {
    final = await inspectClone(deps, o.state)
    if (reasonOf(final)) return kept(o, final, session, reasonOf(final))
  }
  const out: CloseOutcome = { ...kept(o, final, session), clone: "failed" }
  if (final.clone !== "absent" && !(await removeClone(deps, key))) return out
  out.clone = final.clone === "absent" ? "absent" : "removed"
  out.branch = await removeBranch(deps, key, branch, options.discardWork)
  if (out.branch === "failed") return out
  out.record = removeRecord(o) ? "removed" : "kept"
  return { ...out, closed: out.record === "removed" }
}

export type CloseCandidates = { states: Array<HostSessionState & { sessionID: string }>; legacy: number; otherBox: number; otherBridge: number }

function readCursor(file: string): string {
  try {
    const raw = snapshotRecord(file)?.raw ?? ""
    return raw.endsWith(".json") && SESSION_KEY.test(raw.slice(0, -5)) ? raw : ""
  } catch {
    return ""
  }
}

/** Best effort, as #63's prune cursor: a lost cursor only means the next call starts at the top. */
function saveCursor(file: string, name: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, name, { flag: "wx" })
    renameSync(tmp, file)
  } catch {
    // the sweep result stands without it
  } finally {
    try { unlinkSync(tmp) } catch { /* renamed or never made */ }
  }
}

function readCandidate(dir: string, name: string): HostSessionState | undefined {
  try {
    const snap = snapshotRecord(path.join(dir, name))
    return snap ? parseHostState(snap.raw, name.slice(0, -5)) : undefined
  } catch {
    return undefined
  }
}

/**
 * This bridge's bound records of this box created before `before` (at most `limit`), continuing after
 * the last name a previous call reached (persisted cursor), so kept records never block later ones.
 * Reads records only; writes only its cursor file. Counts legacy, other-box and other-bridge records seen.
 */
export function closeCandidates(deps: Pick<CloseDeps, "stateDir" | "boxProject">, supervisor: string, before: Date, limit: number): CloseCandidates {
  const out: CloseCandidates = { states: [], legacy: 0, otherBox: 0, otherBridge: 0 }
  if (!SUPERVISOR_RE.test(supervisor)) return out
  let names: string[]
  try {
    names = readdirSync(deps.stateDir).filter((name) => name.endsWith(".json") && SESSION_KEY.test(name.slice(0, -5))).sort()
  } catch {
    return out
  }
  const cursorFile = path.join(deps.stateDir, `.close-${supervisor.slice("supervisor:".length)}.cursor`)
  const cursor = readCursor(cursorFile)
  const start = names.findIndex((name) => name > cursor)
  const ordered = start <= 0 ? names : [...names.slice(start), ...names.slice(0, start)]
  let last = ""
  for (const name of ordered.slice(0, MAX_SCAN)) {
    if (out.states.length >= limit) break
    last = name
    const state = readCandidate(deps.stateDir, name)
    if (!state?.sessionID || !state.supervisor) continue
    if (state.supervisor !== supervisor) out.otherBridge++
    else if (state.boxProject === undefined) out.legacy++
    else if (state.boxProject !== deps.boxProject) out.otherBox++
    else if (Date.parse(state.createdAt) < before.getTime()) out.states.push({ ...state, sessionID: state.sessionID })
  }
  if (last) saveCursor(cursorFile, last)
  return out
}
