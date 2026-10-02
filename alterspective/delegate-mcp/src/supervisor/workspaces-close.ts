// #72: close a finished session — its OpenCode session, its box clone (/sessions/<key>), its host
// record and, when asked, the host branch delegate/<key>. Two passes (AILES-056): every check runs
// before the first write, so a refusal changes nothing. Then, in order: session, clone, branch,
// record; the first failure stops there and keeps the host record, so a retry can finish the job.
// Data-loss guards: commits in the clone that no host branch contains, and uncommitted files, are
// refused unless `force`. The host branch is deleted only when merged into HEAD or the session's
// base (never when checked out anywhere), unless `force`; the delete is a compare-and-delete of that
// one ref. Only records of this bridge (supervisor), this box (boxProject) and this session id.
import { readdirSync } from "node:fs"
import path from "node:path"
import { DelegateError } from "../shared/errors.ts"
import type { Exec } from "./workspaces-exec.ts"
import { ABSENT_CLONE_PROBE, removeUnchanged, snapshotRecord } from "./workspaces-prune.ts"
import { COMMIT_ID, parseHostState, SESSION_KEY, SUPERVISOR_RE, type HostSessionState } from "./workspaces-state.ts"

/** Most refs read from one clone; a clone with more is not inspected (check_failed). */
const MAX_TIPS = 50

export type CloseOwner = { supervisor: string; sessionID: string }
export type CloseOptions = { force: boolean; deleteBranch: boolean }
/** What deleting the OpenCode session did; a failure is thrown. */
export type SessionRemoval = "deleted" | "already_gone"
export type BranchPlan = "not_requested" | "absent" | "merged" | "unmerged" | "checked_out" | "unknown"
export type CloseRefusal = "uncollected_work" | "check_failed"

export type ClosePlan = {
  sessionKey: string
  sessionID: string
  clone: "present" | "absent" | "unknown"
  /** Commits only the clone has (no host branch contains them). */
  uncollectedCommits: number
  /** Changed or untracked paths in the clone's work tree (never collected by oc_collect). */
  uncommittedPaths: number
  /** Nothing would be lost and every check could be made. */
  safe: boolean
  reason?: CloseRefusal
  branch: BranchPlan
}

export type CloseOutcome = {
  sessionKey: string
  sessionID: string
  /** Session, clone and record are all gone. */
  closed: boolean
  refused?: CloseRefusal
  session: SessionRemoval | "kept"
  clone: "removed" | "absent" | "kept" | "failed"
  branch: "not_requested" | "absent" | "deleted" | "kept_unmerged" | "kept_checked_out" | "kept_unknown" | "failed"
  record: "removed" | "kept"
  uncollectedCommits: number
  uncommittedPaths: number
}

export type CloseDeps = {
  stateDir: string
  boxSessions: string
  boxProject: string
  host: Exec
  box: Exec
  timeoutMs: number
  /** The owner repo, re-checked against the allowed roots (workspaces.resolveRepo). */
  resolveRepo: (hostRepo: string) => Promise<string>
}

type Owned = { state: HostSessionState & { sessionID: string }; snapshot: NonNullable<ReturnType<typeof snapshotRecord>>; file: string }
type CloneState = Pick<ClosePlan, "clone" | "uncollectedCommits" | "uncommittedPaths"> & { failed?: boolean }
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

/** 44 absent, 45 present, anything else (box down, unreadable parent) unknown. */
async function probeClone(deps: CloseDeps, key: string): Promise<"present" | "absent" | "unknown"> {
  const result = await deps.box(["sh", "-c", ABSENT_CLONE_PROBE, "sh", clonePath(deps, key), deps.boxSessions], { timeoutMs: deps.timeoutMs })
  if (result.timedOut || result.stdout.trim() || result.stderr.trim()) return "unknown"
  return result.code === 44 ? "absent" : result.code === 45 ? "present" : "unknown"
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

/** Changed + untracked paths in the clone (`-z`: a rename or copy carries a second, original path). */
async function uncommitted(deps: CloseDeps, key: string): Promise<number | undefined> {
  const result = await boxGit(deps, key, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])
  if (result.code !== 0) return undefined
  const entries = result.stdout.split("\u0000")
  let count = 0
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ""
    if (!entry) continue
    count++
    if (/^[RC]/.test(entry)) i++
  }
  return count
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

/** The host's delegate/<key> commit: undefined when absent, null when git failed. */
async function hostBranchTip(deps: CloseDeps, repo: string, key: string): Promise<string | undefined | null> {
  const result = await hostGit(deps, repo, ["rev-parse", "--verify", "--quiet", `refs/heads/delegate/${key}^{commit}`])
  if (result.code === 1) return undefined
  const tip = result.stdout.trim()
  return result.code === 0 && COMMIT_ID.test(tip) ? tip : null
}

/** How many clone commits the host lacks: reachable from `lost`, not from the base or what the host already has. */
async function countLost(deps: CloseDeps, key: string, repo: string, base: string, lost: string[], collected: string[]): Promise<number | undefined> {
  const hostTip = await hostBranchTip(deps, repo, key)
  const known = [base, ...collected]
  if (typeof hostTip === "string" && (await boxGit(deps, key, ["rev-parse", "--verify", "--quiet", `${hostTip}^{commit}`])).code === 0) known.push(hostTip)
  const result = await boxGit(deps, key, ["rev-list", "--count", ...lost, "--not", ...known])
  const count = Number(result.stdout.trim())
  return result.code === 0 && Number.isInteger(count) ? count : undefined
}

const unknownClone: CloneState = { clone: "unknown", uncollectedCommits: 0, uncommittedPaths: 0, failed: true }

/** What closing would lose from the clone. Reads only (box git and host git). */
async function inspectClone(deps: CloseDeps, state: HostSessionState): Promise<CloneState> {
  const key = state.sessionKey
  const presence = await probeClone(deps, key)
  if (presence !== "present") return presence === "absent" ? { clone: "absent", uncollectedCommits: 0, uncommittedPaths: 0 } : unknownClone
  const [tips, dirty] = [await cloneTips(deps, key), await uncommitted(deps, key)]
  if (tips === undefined || dirty === undefined) return unknownClone
  const candidates = tips.filter((tip) => tip !== state.base)
  if (!candidates.length) return { clone: "present", uncollectedCommits: 0, uncommittedPaths: dirty }
  const repo = await deps.resolveRepo(state.hostRepo).catch(() => undefined)
  if (!repo) return { ...unknownClone, clone: "present", uncommittedPaths: dirty }
  const lost: string[] = []
  const collected: string[] = []
  for (const tip of candidates) {
    const onHost = await onHostBranch(deps, repo, tip)
    if (onHost === undefined) return { ...unknownClone, clone: "present", uncommittedPaths: dirty }
    ;(onHost ? collected : lost).push(tip)
  }
  if (!lost.length) return { clone: "present", uncollectedCommits: 0, uncommittedPaths: dirty }
  const count = await countLost(deps, key, repo, state.base, lost, collected)
  if (count === undefined) return { ...unknownClone, clone: "present", uncommittedPaths: dirty }
  return { clone: "present", uncollectedCommits: count, uncommittedPaths: dirty }
}

const ancestor = async (deps: CloseDeps, repo: string, commit: string, of: string) => (await hostGit(deps, repo, ["merge-base", "--is-ancestor", commit, of])).code === 0

/** Whether delegate/<key> may be deleted: merged into HEAD or the base, and checked out nowhere. */
async function inspectBranch(deps: CloseDeps, state: HostSessionState): Promise<BranchState> {
  const repo = await deps.resolveRepo(state.hostRepo).catch(() => undefined)
  if (!repo) return { plan: "unknown" }
  const tip = await hostBranchTip(deps, repo, state.sessionKey)
  if (tip === undefined) return { plan: "absent", repo }
  if (tip === null) return { plan: "unknown", repo }
  const worktrees = await hostGit(deps, repo, ["worktree", "list", "--porcelain"])
  if (worktrees.code !== 0) return { plan: "unknown", repo, tip }
  const ref = `branch refs/heads/delegate/${state.sessionKey}`
  if (worktrees.stdout.split(/\r?\n/).some((line) => line.trim() === ref)) return { plan: "checked_out", repo, tip }
  const merged = (await ancestor(deps, repo, tip, "HEAD")) || (await ancestor(deps, repo, tip, state.base))
  return { plan: merged ? "merged" : "unmerged", repo, tip }
}

function planOf(o: Owned, clone: CloneState, branch: BranchState): ClosePlan {
  const reason: CloseRefusal | undefined = clone.failed ? "check_failed" : clone.uncollectedCommits > 0 || clone.uncommittedPaths > 0 ? "uncollected_work" : undefined
  const { failed: _failed, ...counts } = clone
  return { sessionKey: o.state.sessionKey, sessionID: o.state.sessionID, ...counts, safe: reason === undefined, ...(reason ? { reason } : {}), branch: branch.plan }
}

async function inspect(deps: CloseDeps, key: string, owner: CloseOwner, deleteBranch: boolean): Promise<{ o: Owned; plan: ClosePlan; branch: BranchState }> {
  const o = owned(deps, key, owner)
  const clone = await inspectClone(deps, o.state)
  const branch: BranchState = deleteBranch ? await inspectBranch(deps, o.state) : { plan: "not_requested" }
  return { o, plan: planOf(o, clone, branch), branch }
}

/** Read-only: what closing would do and lose. */
export async function inspectClose(deps: CloseDeps, key: string, owner: CloseOwner, options: Pick<CloseOptions, "deleteBranch">): Promise<ClosePlan> {
  return (await inspect(deps, key, owner, options.deleteBranch)).plan
}

/** rm the clone (path from the validated key only), then prove it is gone. */
async function removeClone(deps: CloseDeps, key: string): Promise<boolean> {
  const result = await deps.box(["rm", "-rf", "--", clonePath(deps, key)], { timeoutMs: deps.timeoutMs })
  if (result.code !== 0) return false
  return (await probeClone(deps, key)) === "absent"
}

/** Compare-and-delete of exactly refs/heads/delegate/<key> at the inspected tip; never another ref, never a checkout. */
async function removeBranch(deps: CloseDeps, key: string, branch: BranchState, force: boolean): Promise<CloseOutcome["branch"]> {
  if (branch.plan === "not_requested" || branch.plan === "absent") return branch.plan
  if (branch.plan === "checked_out") return "kept_checked_out"
  if (branch.plan === "unknown" || !branch.repo || !branch.tip) return "kept_unknown"
  if (branch.plan === "unmerged" && !force) return "kept_unmerged"
  const result = await hostGit(deps, branch.repo, ["update-ref", "-d", `refs/heads/delegate/${key}`, branch.tip])
  return result.code === 0 ? "deleted" : "failed"
}

const counts = (plan: ClosePlan) => ({ uncollectedCommits: plan.uncollectedCommits, uncommittedPaths: plan.uncommittedPaths })

/** Pass 2 after the session is gone: clone, branch, record; stops at the first failure. */
async function removeRest(deps: CloseDeps, o: Owned, plan: ClosePlan, branch: BranchState, options: CloseOptions, session: SessionRemoval): Promise<CloseOutcome> {
  const key = o.state.sessionKey
  const out: CloseOutcome = { sessionKey: key, sessionID: o.state.sessionID, closed: false, session, clone: "kept", branch: "not_requested", record: "kept", ...counts(plan) }
  if (plan.clone !== "absent") {
    // The session is gone now, so nothing writes to the clone any more: check again before removing it.
    if (!options.force) {
      const again = await inspectClone(deps, o.state)
      if (again.failed || again.uncollectedCommits > 0 || again.uncommittedPaths > 0) return { ...out, refused: again.failed ? "check_failed" : "uncollected_work", uncollectedCommits: again.uncollectedCommits, uncommittedPaths: again.uncommittedPaths }
    }
    if (!(await removeClone(deps, key))) return { ...out, clone: "failed" }
  }
  out.clone = plan.clone === "absent" ? "absent" : "removed"
  out.branch = await removeBranch(deps, key, branch, options.force)
  if (out.branch === "failed") return out
  out.record = removeRecord(o) ? "removed" : "kept"
  return { ...out, closed: out.record === "removed" }
}

/** Only the record read in pass 1, unchanged; one replaced or removed meanwhile (another close) is kept / not counted. */
function removeRecord(o: Owned): boolean {
  try {
    return removeUnchanged(o.file, o.snapshot)
  } catch {
    return false
  }
}

/** Close one session. A refusal (uncollected work, failed checks) writes nothing. `deleteSession` throws on failure. */
export async function closeSession(deps: CloseDeps, key: string, owner: CloseOwner, options: CloseOptions, deleteSession: () => Promise<SessionRemoval>): Promise<CloseOutcome> {
  const { o, plan, branch } = await inspect(deps, key, owner, options.deleteBranch)
  if (!plan.safe && !options.force) {
    return { sessionKey: key, sessionID: o.state.sessionID, closed: false, ...(plan.reason ? { refused: plan.reason } : {}), session: "kept", clone: "kept", branch: "not_requested", record: "kept", ...counts(plan) }
  }
  let session: SessionRemoval
  try {
    session = await deleteSession()
  } catch (error) {
    if (error instanceof DelegateError) throw error
    throw new DelegateError("upstream_error", "The sandbox failed to delete the session; its copy and record were kept.", "Retry oc_close_session; if it repeats, run oc_doctor.", String(error).slice(0, 200))
  }
  return removeRest(deps, o, plan, branch, options, session)
}

export type CloseCandidates = { states: Array<HostSessionState & { sessionID: string }>; legacy: number; otherBox: number }

/** This bridge's bound records of this box created before `before`, oldest first (at most `limit`). Reads only. */
export function closeCandidates(deps: Pick<CloseDeps, "stateDir" | "boxProject">, supervisor: string, before: Date, limit: number): CloseCandidates {
  const out: CloseCandidates = { states: [], legacy: 0, otherBox: 0 }
  if (!SUPERVISOR_RE.test(supervisor)) return out
  let names: string[]
  try {
    names = readdirSync(deps.stateDir).filter((name) => name.endsWith(".json") && SESSION_KEY.test(name.slice(0, -5)))
  } catch {
    return out
  }
  const all: Array<HostSessionState & { sessionID: string }> = []
  for (const name of names) {
    let state: HostSessionState | undefined
    try {
      const snap = snapshotRecord(path.join(deps.stateDir, name))
      state = snap ? parseHostState(snap.raw, name.slice(0, -5)) : undefined
    } catch {
      state = undefined
    }
    if (!state?.sessionID || state.supervisor !== supervisor) continue
    if (state.boxProject === undefined) out.legacy++
    else if (state.boxProject !== deps.boxProject) out.otherBox++
    else if (Date.parse(state.createdAt) < before.getTime()) all.push({ ...state, sessionID: state.sessionID })
  }
  out.states = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit)
  return out
}
