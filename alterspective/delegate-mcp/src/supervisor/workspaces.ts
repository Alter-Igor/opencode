// MOD-01 session workspaces (technical-design §4 "Workspaces"; contracts.ts `Workspaces`).
// The owner's repos are never mounted in the box. Code moves by git bundle only:
//   open:    host `git bundle create <handoff>/in/<fresh>.bundle HEAD` (the owner's current branch
//            only, review W3C-11) -> box `git clone --no-checkout` into /sessions/.<key>.<nonce>.tmp,
//            checks out delegate/<key> at the host HEAD, then `mv -T` to /sessions/<key> (refused
//            with directory_busy when it already exists). The host record is workspaces-state.ts.
//   collect: box `git bundle create /handoff/out/<fresh>.bundle delegate/<key>` (a box-only volume) ->
//            `docker cp` streams it into a host-only folder, checked (workspaces-copyout.ts), then
//            `git fetch <bundle>`. The box has no writable host folder (issue G-7).
// No host-side git command ever runs inside the box clone, so hooks planted there cannot run on the host.
// Hand-off hardening: workspaces-handoff.ts. Host-executable detection: workspaces-detect.ts.
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { BridgeConfig } from "../shared/config.ts"
import type { Workspace, Workspaces } from "../shared/contracts.ts"
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { safeLog, silentLogger, type Logger } from "../shared/log.ts"
import { flagChanges, parseRawDiff } from "./workspaces-detect.ts"
import { boxFailure, canonicalPath, invalidFolder, isUnder, runCommand, samePath, systemSubst, type Exec } from "./workspaces-exec.ts"
import { copyOutBundle, dockerTarSource, type TarSource } from "./workspaces-copyout.ts"
import { assertRegularFile, DEFAULT_MAX_BUNDLE_BYTES, planOutBundle, randomNonce, removeQuietly, reserveInBundle } from "./workspaces-handoff.ts"
import { bindHostState, COMMIT_ID, listHostStates, readHostState, removeHostState, SESSION_KEY, writeHostState, type HostSessionState, type SessionBinding } from "./workspaces-state.ts"
import { createSessionPruner, type MissingSession } from "./workspaces-prune.ts"

export { canonicalPath, cleanEnv, isUnder, parseSubst, runCommand, TIMEOUT_CODE, type Exec, type ExecOptions, type ExecResult } from "./workspaces-exec.ts"
export { isHostExecutableMode, isHostExecutablePath, parseRawDiff, scriptsChanged, type RawEntry } from "./workspaces-detect.ts"
export { DEFAULT_MAX_BUNDLE_BYTES, HANDOFF_IN, HANDOFF_OUT } from "./workspaces-handoff.ts"
export { TAR_SLACK_BYTES, type TarSource, type TarStream } from "./workspaces-copyout.ts"

export { AGENT_RE, COMMIT_ID, MODEL_RE, SESSION_ID_RE, SESSION_KEY, SUPERVISOR_RE, type HostSessionState, type SessionBinding, type SessionProfile } from "./workspaces-state.ts"
/** bundle, clone and fetch: whole repositories. */
export const LONG_TIMEOUT_MS = 10 * 60_000
/** every other git / box call. */
export const SHORT_TIMEOUT_MS = 60_000

export type WorkspacesOptions = {
  config: BridgeConfig
  /** Box container name; used by the default box exec (`docker exec <container> ...`). */
  container: string
  /** Host hand-off folder: `<handoffDir>/in` is mounted read-only at `<boxHandoff>/in`. `<boxHandoff>/out` is box-only. Default `<home>/handoff`. */
  handoffDir?: string
  /** Host-only state (base commit per session, quarantined bundles). Never mounted. Default `<home>/workspaces`. */
  stateDir?: string
  boxHandoff?: string
  boxSessions?: string
  hostExec?: Exec
  boxExec?: Exec
  /** Streams a box file out as tar (G-7). Default `docker cp <container>:<path> -`. */
  boxTar?: TarSource
  /** Drive-letter substitutions (e.g. from `subst`). Default: parsed `subst` output on Windows. */
  substMap?: () => Promise<Record<string, string>>
  /** Refuse out-bundles larger than this before fetching. Default 500 MB. */
  maxBundleBytes?: number
  timeouts?: { longMs?: number; shortMs?: number }
  /** Unique part of hand-off and temp names. Default: 16 random hex characters. */
  nonce?: () => string
  /** Every public call and error is logged here with a correlation id (A-17). Default: silent. */
  logger?: Logger
}

type Length = "long" | "short"

type Ctx = {
  roots: string[]
  host: Exec
  box: Exec
  tar: TarSource
  handoffDir: string
  stateDir: string
  boxHandoff: string
  boxSessions: string
  substMap: () => Promise<Record<string, string>>
  maxBundleBytes: number
  timeouts: Record<Length, number>
  nonce: () => string
}

async function hostGit(ctx: Ctx, args: string[], what: string, length: Length = "short"): Promise<string> {
  const result = await ctx.host(["git", ...args], { timeoutMs: ctx.timeouts[length] })
  if (result.code === 0) return result.stdout
  if (result.timedOut) throw new DelegateError("upstream_error", `git took too long to ${what} on the host.`, "Retry; for a very large repository raise the workspace timeout.", "timeout")
  throw new DelegateError("upstream_error", `git failed to ${what} on the host.`, "Check the repository state and retry.", result.stderr.trim())
}

async function boxRun(ctx: Ctx, args: string[], what: string, length: Length = "short"): Promise<string> {
  const result = await ctx.box(args, { timeoutMs: ctx.timeouts[length] })
  if (result.code === 0) return result.stdout
  throw boxFailure(what, result.stderr, result.timedOut)
}

/** `test -e` in the box: exit 1 with no daemon error means "absent". */
async function boxExists(ctx: Ctx, boxPath: string): Promise<boolean> {
  const result = await ctx.box(["test", "-e", boxPath], { timeoutMs: ctx.timeouts.short })
  if (result.code === 0) return true
  if (result.code === 1 && !result.stderr.trim()) return false
  throw boxFailure("check the session folder", result.stderr, result.timedOut)
}

/** Validate and canonicalise an owner repo: an existing git work tree whose top level is under an allowed root. */
async function resolveRepo(ctx: Ctx, hostRepo: string): Promise<string> {
  const subst = await ctx.substMap()
  const roots = ctx.roots.map((root) => {
    try {
      return canonicalPath(root, subst, ctx.roots)
    } catch {
      return path.resolve(root)
    }
  })
  const candidate = canonicalPath(hostRepo, subst, ctx.roots)
  if (!roots.some((root) => isUnder(candidate, root))) throw invalidFolder(ctx.roots, "The folder is outside the allowed roots.", candidate)
  const probe = await ctx.host(["git", "-C", candidate, "rev-parse", "--is-inside-work-tree", "--show-toplevel"], { timeoutMs: ctx.timeouts.short })
  const [inside, top] = probe.stdout.trim().split(/\r?\n/)
  if (probe.code !== 0 || inside !== "true" || !top) throw invalidFolder(ctx.roots, "The folder is not a git work tree.", candidate)
  const toplevel = canonicalPath(top, subst, ctx.roots)
  if (!roots.some((root) => isUnder(toplevel, root))) throw invalidFolder(ctx.roots, "The repository is outside the allowed roots.", toplevel)
  return toplevel
}

function checkKey(key: string) {
  if (!SESSION_KEY.test(key)) throw new DelegateError("invalid_input", "The session key is not valid.", "Use 4-64 characters: a-z, 0-9 and '-'.")
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown"

/** The host record collect() needs; a missing one is not_found (readHostState throws when damaged). */
function readState(ctx: Ctx, key: string): HostSessionState {
  const state = readHostState(ctx.stateDir, key)
  if (state) return state
  throw new DelegateError("not_found", "This session has no workspace record on the host.", "Start a new session with oc_start_session.", `missing: ${key}`)
}

/** The host HEAD commit the session starts from (review A-22). */
async function hostHead(ctx: Ctx, repo: string): Promise<string> {
  const base = (await hostGit(ctx, ["-C", repo, "rev-parse", "--verify", "HEAD^{commit}"], "read HEAD")).trim()
  if (!COMMIT_ID.test(base)) throw new DelegateError("upstream_error", "git returned an unexpected HEAD commit id.", "Check the repository state and retry.", "invalid HEAD")
  return base
}

/**
 * Scratch OpenCode itself writes into the workspace (the fork's observer plugin,
 * packages/opencode/src/plugin/observer.ts: .system_generated/logs, retrospectives). Listed in the
 * clone's .git/info/exclude so it is never seen as untracked work nor committed by `git add -A`.
 */
export const WORKSPACE_EXCLUDES = [".system_generated/"]

/** Clone the bundle into a private temp folder and put delegate/<key> at `base`. */
async function cloneAt(ctx: Ctx, bundle: string, tmp: string, key: string, base: string): Promise<void> {
  await boxRun(ctx, ["git", "clone", "--quiet", "--no-checkout", bundle, tmp], "clone the session workspace", "long")
  // Arguments, never interpolated into the script: the file is $1, the patterns follow.
  const append = 'f="$1"; shift; mkdir -p "$(dirname "$f")" && printf "%s\\n" "$@" >> "$f"'
  await boxRun(ctx, ["sh", "-c", append, "sh", `${tmp}/.git/info/exclude`, ...WORKSPACE_EXCLUDES], "hide OpenCode scratch files from git")
  // -B, not -b: the clone already has delegate/<key> when that is the owner's checked-out branch.
  await boxRun(ctx, ["git", "-C", tmp, "checkout", "--quiet", "-B", `delegate/${key}`, base], "create the session branch", "long")
}

/** Move the finished clone into place; a folder that appeared meanwhile is directory_busy. */
async function moveIntoPlace(ctx: Ctx, tmp: string, final: string, key: string): Promise<void> {
  const result = await ctx.box(["mv", "-T", tmp, final], { timeoutMs: ctx.timeouts.short })
  if (result.code === 0) return
  if (/not empty|exists|cannot overwrite/i.test(result.stderr)) throw busy(key)
  throw boxFailure("move the session workspace into place", result.stderr, result.timedOut)
}

const busy = (key: string) =>
  new DelegateError("directory_busy", `The box already has a workspace for session ${key}.`, "Use a new session key, or end the old session first.")

/** A workspace plus the host HEAD it was cloned at (verified in the box before open returns). */
export type OpenedWorkspace = Workspace & { base: string }

async function open(ctx: Ctx, hostRepo: string, key: string): Promise<OpenedWorkspace> {
  checkKey(key)
  const repo = await resolveRepo(ctx, hostRepo)
  const base = await hostHead(ctx, repo)
  const final = `${ctx.boxSessions}/${key}`
  if (await boxExists(ctx, final)) throw busy(key)
  const tmp = `${ctx.boxSessions}/.${key}.${ctx.nonce()}.tmp`
  const bundle = reserveInBundle(ctx.handoffDir, ctx.boxHandoff, key, ctx.nonce())
  let placed = false
  try {
    await hostGit(ctx, ["-C", repo, "bundle", "create", bundle.hostPath, "HEAD"], "bundle the repository", "long")
    assertRegularFile(bundle.hostPath, "repository bundle")
    await cloneAt(ctx, bundle.boxPath, tmp, key, base)
    await moveIntoPlace(ctx, tmp, final, key)
    placed = true
    const boxBase = (await boxRun(ctx, ["git", "-C", final, "rev-parse", "HEAD"], "read the base commit")).trim()
    if (boxBase !== base) throw new DelegateError("upstream_error", "The session copy does not start at the repository's HEAD.", "Retry oc_start_session.", "base mismatch")
    writeHostState(ctx.stateDir, { sessionKey: key, hostRepo: repo, base, createdAt: new Date().toISOString() })
  } catch (error) {
    await cleanupBox(ctx, placed ? [tmp, final] : [tmp])
    throw error
  } finally {
    removeQuietly(bundle.hostPath)
  }
  return { sessionKey: key, hostRepo: repo, boxPath: final, branch: `delegate/${key}`, base }
}

/** Best effort: a failed open must not leave a half-made workspace behind. Never throws. */
async function cleanupBox(ctx: Ctx, paths: string[]): Promise<void> {
  await ctx.box(["rm", "-rf", "--", ...paths], { timeoutMs: ctx.timeouts.short }).catch(() => undefined)
}

async function discard(ctx: Ctx, key: string): Promise<void> {
  if (!SESSION_KEY.test(key)) return
  await cleanupBox(ctx, [`${ctx.boxSessions}/${key}`])
  removeHostState(ctx.stateDir, key)
}

/** The box made this pack: every object is checked before it reaches the owner's object store (R3-07). */
const FSCK_FETCH = ["-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true"]
/** git's object check refused an object (`error: object <id>: badTimezone: ...`, then `fatal: fsck error ...`). */
const FSCK_FAILED = /fsck error|^error: object [0-9a-f]+:/im
/**
 * The bundle itself is unreadable (R4-07): cut off, bytes damaged, a bad header, or not a bundle.
 * git 2.51 says `early EOF` / `pack has bad object` / `index-pack died`, others `index-pack failed`;
 * a header that lost the branch reads as a missing remote ref. Checked after FSCK_FAILED, because
 * an object-check failure also ends with `index-pack died`.
 */
const BUNDLE_DAMAGED =
  /index-pack (failed|died)|unpack-objects (failed|died)|early EOF|pack has bad object|bad pack header|inflate|invalid gitfile format|not a bundle|bundle file|could not read from remote repository|couldn't find remote ref/i

/** Fetch delegate/<key> from a bundle file; git runs no hook from the bundle. Non-fast-forward is refused. */
async function fetchBranch(ctx: Ctx, repo: string, bundle: string, branch: string): Promise<void> {
  // No --quiet: git then prints nothing for a rejected (non-fast-forward) ref, and the cause is lost.
  const result = await ctx.host(["git", ...FSCK_FETCH, "-C", repo, "fetch", "--no-tags", bundle, `${branch}:${branch}`], { timeoutMs: ctx.timeouts.long })
  if (result.code === 0) return
  if (FSCK_FAILED.test(result.stderr)) {
    throw new DelegateError("policy_violation", `${branch} from the box failed git's object check, so nothing was fetched.`, "Treat the session's commits as suspect: check them with oc_result before collecting again.", result.stderr.trim())
  }
  // Still policy_violation (fail safe): the bridge made this bundle a moment ago, so damage is unexplained.
  if (BUNDLE_DAMAGED.test(result.stderr)) {
    throw new DelegateError("policy_violation", `The bundle of ${branch} from the box is damaged or incomplete, so nothing was fetched.`, "Collect again; if it repeats, treat the session as suspect and check it with oc_result.", result.stderr.trim())
  }
  if (/non-fast-forward|\[rejected\]/i.test(result.stderr)) {
    throw new DelegateError("branch_diverged", `${branch} changed on the host and in the box (not a fast-forward); nothing was overwritten.`, `Rename or delete the host branch ${branch} (or merge it by hand), then collect again.`, result.stderr.trim())
  }
  if (/refusing to fetch into|checked out/i.test(result.stderr)) {
    throw new DelegateError("directory_busy", `${branch} is checked out in the host repository, so it cannot be updated.`, "Switch the host repository to another branch, then collect again.", result.stderr.trim())
  }
  if (result.timedOut) throw new DelegateError("upstream_error", "git took too long to fetch the session branch on the host.", "Retry; if it repeats, run oc_doctor.", "timeout")
  throw new DelegateError("upstream_error", "git failed to fetch the session branch on the host.", "Check the repository state and retry.", result.stderr.trim())
}

async function executableChanges(ctx: Ctx, repo: string, base: string, branch: string): Promise<string[]> {
  const args = ["-C", repo, "diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", base, branch, "--"]
  const entries = parseRawDiff(await hostGit(ctx, args, "list changed files"))
  return flagChanges(entries, base, branch, async (rev, file) => {
    const result = await ctx.host(["git", "-C", repo, "cat-file", "blob", `${rev}:${file}`], { timeoutMs: ctx.timeouts.short })
    return result.code === 0 ? result.stdout : undefined
  })
}

async function collect(ctx: Ctx, ws: Workspace) {
  checkKey(ws.sessionKey)
  const state = readState(ctx, ws.sessionKey)
  if (!samePath(state.hostRepo, ws.hostRepo)) throw invalidFolder(ctx.roots, "The workspace does not match its host record.", ws.hostRepo)
  const branch = `delegate/${ws.sessionKey}`
  const bundle = planOutBundle(ctx.boxHandoff, path.join(ctx.stateDir, "incoming"), ws.sessionKey, ctx.nonce())
  try {
    await boxRun(ctx, ["git", "-C", `${ctx.boxSessions}/${ws.sessionKey}`, "bundle", "create", "--quiet", bundle.boxPath, branch], "bundle the session branch", "long")
    const local = await copyOutBundle(ctx.box, ctx.tar, bundle, ctx.maxBundleBytes, ctx.timeouts.long)
    await fetchBranch(ctx, state.hostRepo, local, branch)
  } finally {
    await cleanupBox(ctx, [bundle.boxPath])
    removeQuietly(bundle.quarantinePath)
  }
  const count = await hostGit(ctx, ["-C", state.hostRepo, "rev-list", "--count", `${state.base}..${branch}`], "count commits")
  const hostExecutableChanges = await executableChanges(ctx, state.hostRepo, state.base, branch)
  return { branch, commits: Number(count.trim()), hostExecutableChanges }
}

/** Per-call options: the caller's correlation id ties these log lines to its own (A-17). */
export type CallOptions = { correlationId?: string }

/** The Workspaces contract, with open() also returning the verified base commit. */
export type DelegateWorkspaces = Omit<Workspaces, "open" | "collect"> & {
  open(hostRepo: string, sessionKey: string, call?: CallOptions): Promise<OpenedWorkspace>
  collect(workspace: Workspace, call?: CallOptions): ReturnType<Workspaces["collect"]>
  resolveRepo(hostRepo: string, call?: CallOptions): Promise<string>
  /** Record the OpenCode session a workspace became (W3C-01): the only source adoption trusts. */
  bindSession(sessionKey: string, binding: SessionBinding): Promise<HostSessionState>
  /** The host record for a session key; undefined when there is none (throws when damaged). */
  sessionState(sessionKey: string): Promise<HostSessionState | undefined>
  /** Every readable host record, newest first. */
  listSessionStates(): Promise<HostSessionState[]>
  /**
   * #53: bounded cleanup of confirmed missing sessions whose clones are also proved absent. Only
   * records this box made (same `boxProject`) and sessions not `tracked` in memory. Returns removed keys.
   */
  pruneSessionStates(supervisor: string, missing: MissingSession, tracked?: (sessionID: string) => boolean): Promise<string[]>
  /** Best effort (W3A-14): remove the box clone and the host record of a session that never started. Never throws. */
  discard(sessionKey: string): Promise<void>
}

/** Anything that is not a DelegateError yet becomes one; its text goes to detail only. */
function asDelegateError(error: unknown): DelegateError {
  if (isDelegateError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  return new DelegateError("upstream_error", "The workspace step hit an unexpected error.", "Retry; if it repeats, run oc_doctor (the bridge log has the details).", `${errno(error)}: ${message.slice(0, 300)}`)
}

/** Log a public call, its outcome and any error with one correlation id (A-17). Logging never throws. */
async function traced<T>(logger: Logger, op: string, call: CallOptions | undefined, fields: Record<string, string>, fn: () => Promise<T>, done?: (result: T) => Record<string, string | number | boolean>): Promise<T> {
  const correlationId = call?.correlationId ?? randomUUID()
  const began = Date.now()
  safeLog(logger, "info", "workspaces", `${op} called`, { correlationId, ...fields })
  try {
    const result = await fn()
    safeLog(logger, "info", "workspaces", `${op} done`, { correlationId, ms: Date.now() - began, ...fields, ...done?.(result) })
    return result
  } catch (error) {
    const failure = asDelegateError(error)
    safeLog(logger, "error", "workspaces", `${op} failed`, { correlationId, code: failure.code, detail: failure.detail, ms: Date.now() - began, ...fields })
    throw failure
  }
}

export function createWorkspaces(options: WorkspacesOptions): DelegateWorkspaces {
  const ctx: Ctx = {
    roots: options.config.roots,
    host: options.hostExec ?? ((argv, o) => runCommand(argv, undefined, o?.timeoutMs)),
    box: options.boxExec ?? ((argv, o) => runCommand(["docker", "exec", options.container, ...argv], undefined, o?.timeoutMs)),
    tar: options.boxTar ?? dockerTarSource(options.container),
    handoffDir: options.handoffDir ?? path.join(options.config.home, "handoff"),
    stateDir: options.stateDir ?? path.join(options.config.home, "workspaces"),
    boxHandoff: options.boxHandoff ?? "/handoff",
    boxSessions: options.boxSessions ?? "/sessions",
    substMap: options.substMap ?? systemSubst,
    maxBundleBytes: options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES,
    timeouts: { long: options.timeouts?.longMs ?? LONG_TIMEOUT_MS, short: options.timeouts?.shortMs ?? SHORT_TIMEOUT_MS },
    nonce: options.nonce ?? randomNonce,
  }
  const logger = options.logger ?? silentLogger
  // #53: the host records folder is shared by every project under one home; the record names its box.
  const boxProject = options.config.project
  const pruneSessionStates = createSessionPruner({ stateDir: ctx.stateDir, boxSessions: ctx.boxSessions, box: ctx.box, boxProject, timeoutMs: ctx.timeouts.short })
  // Session keys are logged (they are the owner's own labels); repo paths go only to failure detail.
  return {
    open: (hostRepo: string, sessionKey: string, call?: CallOptions) =>
      traced(logger, "open", call, { sessionKey }, () => open(ctx, hostRepo, sessionKey), (ws) => ({ branch: ws.branch })),
    collect: (ws: Workspace, call?: CallOptions) =>
      traced(logger, "collect", call, { sessionKey: ws.sessionKey }, () => collect(ctx, ws), (r) => ({ branch: r.branch, commits: r.commits, hostExecutableChanges: r.hostExecutableChanges.length })),
    resolveRepo: (hostRepo: string, call?: CallOptions) => traced(logger, "resolveRepo", call, {}, () => resolveRepo(ctx, hostRepo)),
    bindSession: async (key, binding) => bindHostState(ctx.stateDir, key, { ...binding, boxProject }),
    sessionState: async (key) => readHostState(ctx.stateDir, key),
    listSessionStates: async () => listHostStates(ctx.stateDir),
    pruneSessionStates,
    discard: (key) => discard(ctx, key),
  }
}
