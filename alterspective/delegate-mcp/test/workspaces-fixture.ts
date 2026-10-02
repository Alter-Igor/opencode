// Shared fixture for the workspace tests: real git on scratch repos under %TEMP% (never inside C:\GitHub).
// The box is simulated: `boxExec` runs git locally with /handoff and /sessions mapped to temp folders and
// with no global/system git config, standing in for `docker exec <box> ...`. The few coreutils the
// bridge uses in the box (`test -e`, `mv -T`, `rm -rf`, `stat -c '%F|%s'`) are emulated with node:fs.
// `docker cp <box>:<path> -` (G-7) is the system tar writing the mapped path to stdout.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultConfig } from "../src/shared/config.ts"
import type { DelegateError } from "../src/shared/errors.ts"
import { spawnStream } from "../src/supervisor/workspaces-copyout.ts"
import { cleanEnv, createWorkspaces, runCommand, type Exec, type ExecResult, type TarSource, type WorkspacesOptions } from "../src/supervisor/workspaces.ts"

export const T = 60_000
export const OK: ExecResult = { code: 0, stdout: "", stderr: "" }
export const posix = (p: string) => p.replace(/\\/g, "/")
const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false"]

export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommand(["git", "-C", cwd, ...identity, ...args], env)
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout.trim()
}

export const failure = async (p: Promise<unknown>) => (await p.catch((e: unknown) => e)) as DelegateError
export const code = async (p: Promise<unknown>) => (await failure(p)).code

/** A symlink where allowed; on Windows without the privilege, a junction (needs none) to the target's folder. */
export function plantLink(target: string, at: string): void {
  try {
    symlinkSync(target, at, "file")
  } catch {
    symlinkSync(statSync(target).isDirectory() ? target : path.dirname(target), at, "junction")
  }
}

/** Windows briefly holds a just-written folder (git, indexer, antivirus): EPERM on rename. The box is Linux. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(from, to)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" || attempt >= 40) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

/** GNU `stat -c '%F|%s'` without -L: a link is reported as a link. */
function statKind(p: string): ExecResult {
  let s: ReturnType<typeof lstatSync>
  try {
    s = lstatSync(p)
  } catch {
    return { code: 1, stdout: "", stderr: `stat: cannot statx '${p}': No such file or directory` }
  }
  const kind = s.isSymbolicLink() ? "symbolic link" : s.isDirectory() ? "directory" : s.isFile() ? (s.size === 0 ? "regular empty file" : "regular file") : "fifo"
  return { ...OK, stdout: `${kind}|${s.size}
` }
}

const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar"

function coreutils(argv: string[]): ExecResult | undefined {
  const [cmd, flag, ...rest] = argv
  if (cmd === "stat" && flag === "-c") return statKind(rest.at(-1) ?? "")
  if (cmd === "test" && flag === "-e") return { ...OK, code: existsSync(rest[0] ?? "") ? 0 : 1 }
  if (cmd === "mv" && flag === "-T") {
    const [from = "", to = ""] = rest
    if (existsSync(to) && readdirSync(to).length > 0) return { code: 1, stdout: "", stderr: `mv: cannot move '${from}' to '${to}': Directory not empty` }
    rmSync(to, { recursive: true, force: true })
    renameWithRetry(from, to)
    return OK
  }
  if (cmd === "rm" && flag === "-rf") {
    for (const p of rest.filter((a) => a !== "--")) rmSync(p, { recursive: true, force: true })
    return OK
  }
  return undefined
}

export type BoxOverride = (argv: string[]) => Promise<ExecResult | undefined> | ExecResult | undefined

export class WorkspaceFixture {
  tmp = ""
  root = ""
  hostRepo = ""
  handoff = ""
  sessions = ""
  marker = ""
  boxEnv: NodeJS.ProcessEnv = {}
  /** Per-test hook (reset by the test files' beforeEach): return a result to replace a box command. */
  boxOverride: BoxOverride | undefined

  constructor(private readonly prefix: string) {}

  private boxPath = (p: string) => p.replace(/^\/handoff(?=\/|$)/, posix(this.handoff)).replace(/^\/sessions(?=\/|$)/, posix(this.sessions))

  /** `docker cp <box>:<path> -`: the system tar archives the mapped path (a link stays a link). */
  readonly boxTar: TarSource = (boxPath, timeoutMs) => {
    const local = this.boxPath(boxPath)
    return spawnStream([TAR, "-cf", "-", "-C", path.dirname(local), path.basename(local)], timeoutMs)
  }

  readonly boxExec: Exec = async (argv, options) => {
    const args = argv.map(this.boxPath)
    const replaced = await this.boxOverride?.(args)
    if (replaced) return replaced
    return coreutils(args) ?? runCommand(args, this.boxEnv, options?.timeoutMs)
  }

  async setup(): Promise<void> {
    this.tmp = mkdtempSync(path.join(os.tmpdir(), this.prefix))
    this.root = path.join(this.tmp, "root")
    this.hostRepo = path.join(this.root, "repo")
    this.handoff = path.join(this.tmp, "handoff")
    this.sessions = path.join(this.tmp, "sessions")
    this.marker = path.join(this.tmp, "HOOK-RAN")
    mkdirSync(this.hostRepo, { recursive: true })
    mkdirSync(this.sessions, { recursive: true })
    mkdirSync(path.join(this.handoff, "out"), { recursive: true }) // the box-only volume (always there in the box)
    const emptyGlobal = path.join(this.tmp, "empty.gitconfig")
    writeFileSync(emptyGlobal, "")
    this.boxEnv = { ...cleanEnv(), GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: "1" }
    await git(this.hostRepo, ["init", "-q", "-b", "main"])
    writeFileSync(path.join(this.hostRepo, "README.md"), "hello\n")
    writeFileSync(path.join(this.hostRepo, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test" } }, null, 2))
    mkdirSync(path.join(this.hostRepo, "sub"))
    writeFileSync(path.join(this.hostRepo, "sub", "package.json"), JSON.stringify({ name: "sub", version: "1.0.0", scripts: { a: "b" } }))
    await git(this.hostRepo, ["add", "-A"])
    await git(this.hostRepo, ["commit", "-q", "-m", "base"])
  }

  teardown(): void {
    if (this.tmp) rmSync(this.tmp, { recursive: true, force: true })
  }

  workspaces(extra: Partial<WorkspacesOptions> = {}) {
    const config = { ...defaultConfig({}), home: path.join(this.tmp, "home"), roots: [this.root] }
    const base = { config, container: "unused-in-tests", handoffDir: this.handoff, stateDir: path.join(this.tmp, "state"), boxExec: this.boxExec, boxTar: this.boxTar }
    return createWorkspaces({ ...base, substMap: async () => ({}), ...extra })
  }

  boxClone = (key: string) => path.join(this.sessions, key)
  boxGit = (key: string, args: string[]) => git(this.boxClone(key), args, this.boxEnv)
  hostHas = async (ref: string) => (await runCommand(["git", "-C", this.hostRepo, "rev-parse", "--verify", "--quiet", ref])).code === 0
  /** Session folders (final or temp) left in the box for `key`. */
  leftovers = (key: string) => readdirSync(this.sessions).filter((n) => n.startsWith(`.${key}.`) || n === key)
  handoffFiles = () => ["in", "out"].flatMap((d) => (existsSync(path.join(this.handoff, d)) ? readdirSync(path.join(this.handoff, d)) : []))
  incoming = () => (existsSync(path.join(this.tmp, "state", "incoming")) ? readdirSync(path.join(this.tmp, "state", "incoming")) : [])

  async boxCommit(key: string, files: Record<string, string>, message: string): Promise<void> {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(this.boxClone(key), file)), { recursive: true })
      writeFileSync(path.join(this.boxClone(key), file), content)
    }
    await this.boxGit(key, ["add", "-A"])
    // The key in the body keeps each test's commit unique: two tests committing the same tree with
    // the same message in the same second would otherwise make one commit id (and one could look
    // collected because another test already put it on a host branch).
    await this.boxGit(key, ["commit", "-q", "-m", message, "-m", `fixture: ${key}`])
  }
}
