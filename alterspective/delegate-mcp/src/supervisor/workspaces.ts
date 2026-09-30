// MOD-01 session workspaces (technical-design §4 "Workspaces"; contracts.ts `Workspaces`).
// The owner's repos are never mounted in the box. Code moves by git bundle only:
//   open:    host `git bundle create <handoff>/in/<fresh>.bundle --all` -> box `git clone --no-checkout`
//            into /sessions/.<key>.<nonce>.tmp, checks out delegate/<key> at the host HEAD, then `mv -T`
//            to /sessions/<key> (refused with directory_busy when it already exists)
//   collect: box `git bundle create /handoff/out/<fresh>.bundle delegate/<key>` -> host moves it to a
//            host-only folder, checks it, then `git fetch <bundle>`
// No host-side git command ever runs inside the box clone, so hooks planted there cannot run on the host.
// Hand-off hardening: workspaces-handoff.ts. Host-executable detection: workspaces-detect.ts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { BridgeConfig } from "../shared/config.ts"
import type { Workspace, Workspaces } from "../shared/contracts.ts"
import { DelegateError } from "../shared/errors.ts"
import { flagChanges, parseRawDiff } from "./workspaces-detect.ts"
import { canonicalPath, invalidFolder, isUnder, runCommand, samePath, systemSubst, type Exec } from "./workspaces-exec.ts"
import { assertRegularFile, DEFAULT_MAX_BUNDLE_BYTES, planOutBundle, randomNonce, removeQuietly, reserveInBundle, takeOutBundle } from "./workspaces-handoff.ts"

export { canonicalPath, cleanEnv, isUnder, parseSubst, runCommand, TIMEOUT_CODE, type Exec, type ExecOptions, type ExecResult } from "./workspaces-exec.ts"
export { isHostExecutableMode, isHostExecutablePath, parseRawDiff, scriptsChanged, type RawEntry } from "./workspaces-detect.ts"
export { DEFAULT_MAX_BUNDLE_BYTES, HANDOFF_IN, HANDOFF_OUT } from "./workspaces-handoff.ts"

export const SESSION_KEY = /^[a-z0-9-]{4,64}$/
/** A full commit id: SHA-1 (40 hex) or, for sha256 repositories, 64 hex. */
export const COMMIT_ID = /^([0-9a-f]{40}|[0-9a-f]{64})$/
/** bundle, clone and fetch: whole repositories. */
export const LONG_TIMEOUT_MS = 10 * 60_000
/** every other git / box call. */
export const SHORT_TIMEOUT_MS = 60_000

export type WorkspacesOptions = {
  config: BridgeConfig
  /** Box container name; used by the default box exec (`docker exec <container> ...`). */
  container: string
  /** Host hand-off folder: `in/` is mounted read-only at `<boxHandoff>/in`, `out/` read-write at `<boxHandoff>/out`. Default `<home>/handoff`. */
  handoffDir?: string
  /** Host-only state (base commit per session, quarantined bundles). Never mounted. Default `<home>/workspaces`. */
  stateDir?: string
  boxHandoff?: string
  boxSessions?: string
  hostExec?: Exec
  boxExec?: Exec
  /** Drive-letter substitutions (e.g. from `subst`). Default: parsed `subst` output on Windows. */
  substMap?: () => Promise<Record<string, string>>
  /** Refuse out-bundles larger than this before fetching. Default 500 MB. */
  maxBundleBytes?: number
  timeouts?: { longMs?: number; shortMs?: number }
  /** Unique part of hand-off and temp names. Default: 16 random hex characters. */
  nonce?: () => string
}

type SessionState = { hostRepo: string; base: string }
type Length = "long" | "short"

type Ctx = {
  roots: string[]
  host: Exec
  box: Exec
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

function boxFailure(what: string, stderr: string, timedOut: boolean | undefined): DelegateError {
  if (timedOut) return new DelegateError("upstream_error", `The delegate box took too long to ${what}.`, "Retry; if it repeats, run oc_doctor.", "timeout")
  const down = /no such container|cannot connect|error during connect|is not running/i.test(stderr)
  const action = down ? "Run oc_doctor to start the box." : "Retry; if it repeats, run oc_doctor."
  return new DelegateError(down ? "sandbox_unavailable" : "upstream_error", `The delegate box failed to ${what}.`, action, stderr.trim())
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

const statePath = (ctx: Ctx, key: string) => path.join(ctx.stateDir, `${key}.json`)

function writeState(ctx: Ctx, key: string, state: SessionState): void {
  if (!COMMIT_ID.test(state.base)) throw new DelegateError("upstream_error", "The base commit read from git is not a full commit id.", "Retry oc_start_session.", "invalid base")
  mkdirSync(ctx.stateDir, { recursive: true })
  writeFileSync(statePath(ctx, key), JSON.stringify(state satisfies SessionState))
}

function readState(ctx: Ctx, key: string): SessionState {
  const file = statePath(ctx, key)
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    throw new DelegateError("not_found", "This session has no workspace record on the host.", "Start a new session with oc_start_session.", "missing")
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SessionState>
    if (typeof parsed.hostRepo === "string" && typeof parsed.base === "string" && COMMIT_ID.test(parsed.base)) return { hostRepo: parsed.hostRepo, base: parsed.base }
  } catch {
    // reported below
  }
  throw new DelegateError("not_found", "This session's workspace record on the host is damaged.", `Delete ${file} and start a new session with oc_start_session.`, "corrupt")
}

/** The host HEAD commit the session starts from (review A-22). */
async function hostHead(ctx: Ctx, repo: string): Promise<string> {
  const base = (await hostGit(ctx, ["-C", repo, "rev-parse", "--verify", "HEAD^{commit}"], "read HEAD")).trim()
  if (!COMMIT_ID.test(base)) throw new DelegateError("upstream_error", "git returned an unexpected HEAD commit id.", "Check the repository state and retry.", "invalid HEAD")
  return base
}

/** Clone the bundle into a private temp folder and put delegate/<key> at `base`. */
async function cloneAt(ctx: Ctx, bundle: string, tmp: string, key: string, base: string): Promise<void> {
  await boxRun(ctx, ["git", "clone", "--quiet", "--no-checkout", bundle, tmp], "clone the session workspace", "long")
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

async function open(ctx: Ctx, hostRepo: string, key: string): Promise<Workspace> {
  checkKey(key)
  const repo = await resolveRepo(ctx, hostRepo)
  const base = await hostHead(ctx, repo)
  const final = `${ctx.boxSessions}/${key}`
  if (await boxExists(ctx, final)) throw busy(key)
  const tmp = `${ctx.boxSessions}/.${key}.${ctx.nonce()}.tmp`
  const bundle = reserveInBundle(ctx.handoffDir, ctx.boxHandoff, key, ctx.nonce())
  let placed = false
  try {
    await hostGit(ctx, ["-C", repo, "bundle", "create", bundle.hostPath, "--all"], "bundle the repository", "long")
    assertRegularFile(bundle.hostPath, "repository bundle")
    await cloneAt(ctx, bundle.boxPath, tmp, key, base)
    await moveIntoPlace(ctx, tmp, final, key)
    placed = true
    const boxBase = (await boxRun(ctx, ["git", "-C", final, "rev-parse", "HEAD"], "read the base commit")).trim()
    if (boxBase !== base) throw new DelegateError("upstream_error", "The session copy does not start at the repository's HEAD.", "Retry oc_start_session.", "base mismatch")
    writeState(ctx, key, { hostRepo: repo, base })
  } catch (error) {
    await cleanupBox(ctx, placed ? [tmp, final] : [tmp])
    throw error
  } finally {
    removeQuietly(bundle.hostPath)
  }
  return { sessionKey: key, hostRepo: repo, boxPath: final, branch: `delegate/${key}` }
}

/** Best effort: a failed open must not leave a half-made workspace behind. Never throws. */
async function cleanupBox(ctx: Ctx, paths: string[]): Promise<void> {
  await ctx.box(["rm", "-rf", "--", ...paths], { timeoutMs: ctx.timeouts.short }).catch(() => undefined)
}

/** Fetch delegate/<key> from a bundle file; git runs no hook from the bundle. Non-fast-forward is refused. */
async function fetchBranch(ctx: Ctx, repo: string, bundle: string, branch: string): Promise<void> {
  // No --quiet: git then prints nothing for a rejected (non-fast-forward) ref, and the cause is lost.
  const result = await ctx.host(["git", "-C", repo, "fetch", "--no-tags", bundle, `${branch}:${branch}`], { timeoutMs: ctx.timeouts.long })
  if (result.code === 0) return
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
  const bundle = planOutBundle(ctx.handoffDir, ctx.boxHandoff, path.join(ctx.stateDir, "incoming"), ws.sessionKey, ctx.nonce())
  try {
    await boxRun(ctx, ["git", "-C", `${ctx.boxSessions}/${ws.sessionKey}`, "bundle", "create", "--quiet", bundle.boxPath, branch], "bundle the session branch", "long")
    const local = takeOutBundle(bundle, ctx.maxBundleBytes)
    await fetchBranch(ctx, state.hostRepo, local, branch)
  } finally {
    removeQuietly(bundle.hostPath)
    removeQuietly(bundle.quarantinePath)
  }
  const count = await hostGit(ctx, ["-C", state.hostRepo, "rev-list", "--count", `${state.base}..${branch}`], "count commits")
  const hostExecutableChanges = await executableChanges(ctx, state.hostRepo, state.base, branch)
  return { branch, commits: Number(count.trim()), hostExecutableChanges }
}

export function createWorkspaces(options: WorkspacesOptions): Workspaces & { resolveRepo(hostRepo: string): Promise<string> } {
  const ctx: Ctx = {
    roots: options.config.roots,
    host: options.hostExec ?? ((argv, o) => runCommand(argv, undefined, o?.timeoutMs)),
    box: options.boxExec ?? ((argv, o) => runCommand(["docker", "exec", options.container, ...argv], undefined, o?.timeoutMs)),
    handoffDir: options.handoffDir ?? path.join(options.config.home, "handoff"),
    stateDir: options.stateDir ?? path.join(options.config.home, "workspaces"),
    boxHandoff: options.boxHandoff ?? "/handoff",
    boxSessions: options.boxSessions ?? "/sessions",
    substMap: options.substMap ?? systemSubst,
    maxBundleBytes: options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES,
    timeouts: { long: options.timeouts?.longMs ?? LONG_TIMEOUT_MS, short: options.timeouts?.shortMs ?? SHORT_TIMEOUT_MS },
    nonce: options.nonce ?? randomNonce,
  }
  return {
    open: (hostRepo, sessionKey) => open(ctx, hostRepo, sessionKey),
    collect: (ws) => collect(ctx, ws),
    resolveRepo: (hostRepo) => resolveRepo(ctx, hostRepo),
  }
}
