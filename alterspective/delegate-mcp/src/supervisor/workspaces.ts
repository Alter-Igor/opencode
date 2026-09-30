// MOD-01 session workspaces (technical-design §4 "Workspaces"; contracts.ts `Workspaces`).
// The owner's repos are never mounted in the box. Code moves by git bundle only:
//   open:    host `git bundle create <handoff>/<key>-in.bundle --all` -> box clones it into /sessions/<key>
//   collect: box `git bundle create /handoff/<key>-out.bundle delegate/<key>` -> host `git fetch <bundle>`
// No host-side git command ever runs inside the box clone, so hooks planted there cannot run on the host.
// Every command is an argument array (no shell strings).
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { BridgeConfig } from "../shared/config.ts"
import type { Workspace, Workspaces } from "../shared/contracts.ts"
import { DelegateError } from "../shared/errors.ts"

export type ExecResult = { code: number; stdout: string; stderr: string }
export type Exec = (argv: readonly string[]) => Promise<ExecResult>

export const SESSION_KEY = /^[a-z0-9-]{4,64}$/

export type WorkspacesOptions = {
  config: BridgeConfig
  /** Box container name; used by the default box exec (`docker exec <container> ...`). */
  container: string
  /** Host folder mounted rw at `boxHandoff`. Default `<home>/handoff`. */
  handoffDir?: string
  /** Host-only state (base commit per session). Never mounted. Default `<home>/workspaces`. */
  stateDir?: string
  boxHandoff?: string
  boxSessions?: string
  hostExec?: Exec
  boxExec?: Exec
  /** Drive-letter substitutions (e.g. from `subst`). Default: parsed `subst` output on Windows. */
  substMap?: () => Promise<Record<string, string>>
}

type SessionState = { hostRepo: string; base: string }

/** Environment for child processes: never inherit GIT_* (GIT_DIR, GIT_CONFIG_PARAMETERS, ...). */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (!/^GIT_/i.test(key)) out[key] = value
  return out
}

export function runCommand(argv: readonly string[], env: NodeJS.ProcessEnv = cleanEnv()): Promise<ExecResult> {
  const [file, ...args] = argv
  if (!file) return Promise.resolve({ code: 127, stdout: "", stderr: "empty command" })
  return new Promise((resolve) => {
    execFile(file, args, { env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : "")) })
    })
  })
}

/** Parse `subst` output lines such as `T:\: => X:\some\dir`. */
export function parseSubst(output: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Za-z]):\\: => (.+)$/.exec(line.trim())
    if (match?.[1] && match[2]) map[match[1].toUpperCase() + ":"] = match[2].trim()
  }
  return map
}

async function systemSubst(): Promise<Record<string, string>> {
  if (process.platform !== "win32") return {}
  const result = await runCommand(["subst"])
  return result.code === 0 ? parseSubst(result.stdout) : {}
}

const invalid = (message: string, detail?: string) =>
  new DelegateError("directory_invalid", message, "Pass a git repository folder under an allowed root (C:\\GitHub).", detail)

function applySubst(p: string, subst: Record<string, string>): string {
  let current = p
  for (let hop = 0; hop < 4; hop++) {
    const drive = current.slice(0, 2).toUpperCase()
    const target = /^[A-Z]:$/.test(drive) ? subst[drive] : undefined
    if (!target) return current
    current = path.win32.join(target, current.slice(2))
  }
  return current
}

/** Canonical, real path of an existing directory (subst and junctions resolved). */
export function canonicalPath(input: string, subst: Record<string, string>): string {
  if (input.split(/[\\/]+/).includes("..")) throw invalid("The folder path may not contain '..'.", input)
  const win = process.platform === "win32"
  const resolved = win ? applySubst(path.win32.resolve(input), subst) : path.resolve(input)
  let real: string
  try {
    real = realpathSync.native(resolved)
  } catch {
    throw invalid("The folder does not exist.", resolved)
  }
  return win ? applySubst(real, subst) : real
}

export function isUnder(candidate: string, root: string): boolean {
  const win = process.platform === "win32"
  const norm = (p: string) => (win ? p.replace(/\//g, "\\").toLowerCase() : p)
  const c = norm(candidate)
  const r = norm(root)
  const sep = win ? "\\" : "/"
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/** Paths whose change could make something run on the owner's host when the branch is checked out or used. */
export function isHostExecutablePath(file: string): boolean {
  const segments = file.split("/")
  const base = segments[segments.length - 1] ?? ""
  if (segments.some((s) => s.startsWith(".git") || s === ".husky")) return true
  if (/^(gnu)?makefile$/i.test(base)) return true
  return /\.(ps1|bat|cmd|sh)$/i.test(base)
}

/** `scripts` of a package.json as a comparable string; undefined when absent, null when unparseable. */
function scriptsOf(json: string | undefined): string | undefined | null {
  if (json === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(json)
    const scripts = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).scripts : undefined
    return scripts === undefined ? undefined : JSON.stringify(scripts)
  } catch {
    return null
  }
}

/** True when `scripts` differs between two package.json versions. Unparseable content fails closed (reported). */
export function scriptsChanged(before: string | undefined, after: string | undefined): boolean {
  const a = scriptsOf(before)
  const b = scriptsOf(after)
  return a === null || b === null || a !== b
}

type Ctx = {
  roots: string[]
  host: Exec
  box: Exec
  handoffDir: string
  stateDir: string
  boxHandoff: string
  boxSessions: string
  substMap: () => Promise<Record<string, string>>
}

async function hostGit(ctx: Ctx, args: string[], what: string): Promise<string> {
  const result = await ctx.host(["git", ...args])
  if (result.code !== 0) throw new DelegateError("upstream_error", `git failed to ${what} on the host.`, "Check the repository state and retry.", result.stderr.trim())
  return result.stdout
}

async function boxRun(ctx: Ctx, args: string[], what: string): Promise<string> {
  const result = await ctx.box(args)
  if (result.code === 0) return result.stdout
  const down = /no such container|cannot connect|error during connect|is not running/i.test(result.stderr)
  const action = down ? "Run oc_doctor to start the box." : "Retry; if it repeats, run oc_doctor."
  throw new DelegateError(down ? "sandbox_unavailable" : "upstream_error", `The delegate box failed to ${what}.`, action, result.stderr.trim())
}

/** Validate and canonicalise an owner repo: an existing git work tree whose top level is under an allowed root. */
async function resolveRepo(ctx: Ctx, hostRepo: string): Promise<string> {
  const subst = await ctx.substMap()
  const roots = ctx.roots.map((root) => {
    try {
      return canonicalPath(root, subst)
    } catch {
      return path.resolve(root)
    }
  })
  const candidate = canonicalPath(hostRepo, subst)
  if (!roots.some((root) => isUnder(candidate, root))) throw invalid("The folder is outside the allowed roots.", candidate)
  const probe = await ctx.host(["git", "-C", candidate, "rev-parse", "--is-inside-work-tree", "--show-toplevel"])
  const [inside, top] = probe.stdout.trim().split(/\r?\n/)
  if (probe.code !== 0 || inside !== "true" || !top) throw invalid("The folder is not a git work tree.", candidate)
  const toplevel = canonicalPath(top, subst)
  if (!roots.some((root) => isUnder(toplevel, root))) throw invalid("The repository is outside the allowed roots.", toplevel)
  return toplevel
}

function checkKey(key: string) {
  if (!SESSION_KEY.test(key)) throw new DelegateError("invalid_input", "The session key is not valid.", "Use 4-64 characters: a-z, 0-9 and '-'.")
}

const statePath = (ctx: Ctx, key: string) => path.join(ctx.stateDir, `${key}.json`)

function readState(ctx: Ctx, key: string): SessionState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(ctx, key), "utf8")) as Partial<SessionState>
    if (typeof parsed.hostRepo === "string" && typeof parsed.base === "string" && /^[0-9a-f]{40,64}$/.test(parsed.base)) {
      return { hostRepo: parsed.hostRepo, base: parsed.base }
    }
  } catch {
    // fall through to not_found
  }
  throw new DelegateError("not_found", "This session has no workspace record on the host.", "Start a new session with oc_start_session.")
}

async function open(ctx: Ctx, hostRepo: string, sessionKey: string): Promise<Workspace> {
  checkKey(sessionKey)
  const repo = await resolveRepo(ctx, hostRepo)
  mkdirSync(ctx.handoffDir, { recursive: true })
  const inBundle = path.join(ctx.handoffDir, `${sessionKey}-in.bundle`)
  const boxPath = `${ctx.boxSessions}/${sessionKey}`
  const branch = `delegate/${sessionKey}`
  try {
    await hostGit(ctx, ["-C", repo, "bundle", "create", inBundle, "--all"], "bundle the repository")
    await boxRun(ctx, ["git", "clone", "--quiet", `${ctx.boxHandoff}/${sessionKey}-in.bundle`, boxPath], "clone the session workspace")
    await boxRun(ctx, ["git", "-C", boxPath, "checkout", "--quiet", "-b", branch], "create the session branch")
    // Read the base before the agent starts; kept host-side only, so the agent cannot move it.
    const base = (await boxRun(ctx, ["git", "-C", boxPath, "rev-parse", "HEAD"], "read the base commit")).trim()
    mkdirSync(ctx.stateDir, { recursive: true })
    writeFileSync(statePath(ctx, sessionKey), JSON.stringify({ hostRepo: repo, base } satisfies SessionState))
  } finally {
    rmSync(inBundle, { force: true })
  }
  return { sessionKey, hostRepo: repo, boxPath, branch }
}

async function blob(ctx: Ctx, repo: string, rev: string, file: string): Promise<string | undefined> {
  const result = await ctx.host(["git", "-C", repo, "cat-file", "blob", `${rev}:${file}`])
  return result.code === 0 ? result.stdout : undefined
}

async function executableChanges(ctx: Ctx, repo: string, base: string, branch: string): Promise<string[]> {
  const args = ["-C", repo, "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, branch, "--"]
  const changed = (await hostGit(ctx, args, "list changed files")).split("\u0000").filter(Boolean)
  const flagged: string[] = []
  for (const file of changed) {
    if (isHostExecutablePath(file)) flagged.push(file)
    else if (path.posix.basename(file) === "package.json") {
      if (scriptsChanged(await blob(ctx, repo, base, file), await blob(ctx, repo, branch, file))) flagged.push(file)
    }
  }
  return flagged
}

const samePath = (a: string, b: string) => isUnder(a, b) && isUnder(b, a)

async function collect(ctx: Ctx, ws: Workspace) {
  checkKey(ws.sessionKey)
  const state = readState(ctx, ws.sessionKey)
  if (!samePath(state.hostRepo, ws.hostRepo)) throw invalid("The workspace does not match its host record.", ws.hostRepo)
  const branch = `delegate/${ws.sessionKey}`
  mkdirSync(ctx.handoffDir, { recursive: true })
  const outBundle = path.join(ctx.handoffDir, `${ws.sessionKey}-out.bundle`)
  try {
    const boxBundle = `${ctx.boxHandoff}/${ws.sessionKey}-out.bundle`
    await boxRun(ctx, ["git", "-C", `${ctx.boxSessions}/${ws.sessionKey}`, "bundle", "create", "--quiet", boxBundle, branch], "bundle the session branch")
    if (!existsSync(outBundle)) throw new DelegateError("upstream_error", "The session bundle did not reach the host.", "Check the hand-off folder mount (oc_doctor).")
    // Fetch from the bundle file: git runs no hook from the bundle or the box clone.
    await hostGit(ctx, ["-C", state.hostRepo, "fetch", "--quiet", "--no-tags", outBundle, `${branch}:${branch}`], "fetch the session branch")
  } finally {
    rmSync(outBundle, { force: true })
  }
  const count = await hostGit(ctx, ["-C", state.hostRepo, "rev-list", "--count", `${state.base}..${branch}`], "count commits")
  const hostExecutableChanges = await executableChanges(ctx, state.hostRepo, state.base, branch)
  return { branch, commits: Number(count.trim()), hostExecutableChanges }
}

export function createWorkspaces(options: WorkspacesOptions): Workspaces & { resolveRepo(hostRepo: string): Promise<string> } {
  const ctx: Ctx = {
    roots: options.config.roots,
    host: options.hostExec ?? ((argv) => runCommand(argv)),
    box: options.boxExec ?? ((argv) => runCommand(["docker", "exec", options.container, ...argv])),
    handoffDir: options.handoffDir ?? path.join(options.config.home, "handoff"),
    stateDir: options.stateDir ?? path.join(options.config.home, "workspaces"),
    boxHandoff: options.boxHandoff ?? "/handoff",
    boxSessions: options.boxSessions ?? "/sessions",
    substMap: options.substMap ?? systemSubst,
  }
  return {
    open: (hostRepo, sessionKey) => open(ctx, hostRepo, sessionKey),
    collect: (ws) => collect(ctx, ws),
    resolveRepo: (hostRepo) => resolveRepo(ctx, hostRepo),
  }
}
