// MOD-01 workspaces: which changes on delegate/<key> could run something on the owner's host
// (reviews A-15, C-3, N-7). Reported to the owner by collect(); never acted on by the bridge.
// Classes:
//   paths      - hook/config folders, tool and agent configs, agent instruction files, build and
//                script files;
//   modes      - symlinks (120000), submodules (160000) and executable files (100755);
//   package.json - when `scripts` or `bin` changed, or a dependency that installs from a local
//                path, a git repository or a URL (file:, link:, git+, git:, github:, http(s):)
//                was added, changed or removed.
// A package.json that cannot be read or parsed is reported (fail closed, review N-8).
// Matching is case-insensitive: the owner's disk (Windows) is.
import path from "node:path"
import { DelegateError } from "../shared/errors.ts"

/** Exact file names (lower case) that a tool on the host reads and may execute from. */
const EXEC_BASENAMES = new Set([
  ".envrc",
  ".pre-commit-config.yaml",
  ".mcp.json",
  "bunfig.toml",
  ".npmrc",
  "setup.py",
  "pyproject.toml",
  "conftest.py",
  "agents.md",
  "claude.md",
  "gemini.md",
  "opencode.json",
  "opencode.jsonc",
  "makefile",
  "gnumakefile",
  "directory.build.props",
  "directory.build.targets",
  "build.rs",
])

/** Folder names (lower case) whose contents a tool on the host reads and may execute. */
const EXEC_SEGMENTS = new Set([".claude", ".opencode", ".cursor", ".codex", ".gemini", ".vscode", ".devcontainer", ".githooks", ".husky"])

/** Scripts, and MSBuild project files (their targets run on build). */
const EXEC_EXTENSIONS = /\.(ps1|psm1|bat|cmd|sh|vbs|csproj|vbproj)$/
/** Modes that change what the path IS: symlink, submodule (gitlink). */
const SPECIAL_MODES = new Set(["120000", "160000"])
const EXECUTABLE_MODE = "100755"
/** Mode git reports for the side of a change where the path does not exist. */
const ABSENT_MODE = "000000"

/** Paths whose change could make something run on the owner's host when the branch is checked out or used. */
export function isHostExecutablePath(file: string): boolean {
  const segments = file.toLowerCase().split("/")
  const base = segments[segments.length - 1] ?? ""
  if (segments.some((s) => s.startsWith(".git") || EXEC_SEGMENTS.has(s))) return true
  if (segments.some((s, i) => s === ".idea" && segments[i + 1] === "runconfigurations")) return true
  if (EXEC_BASENAMES.has(base) || base.startsWith(".yarnrc")) return true
  return EXEC_EXTENSIONS.test(base)
}

export type RawEntry = { srcMode: string; dstMode: string; status: string; path: string }

/** Parse `git diff --raw -z --no-renames` output. Anything unexpected fails closed (throws). */
export function parseRawDiff(output: string): RawEntry[] {
  const parts = output.split("\u0000")
  if (parts[parts.length - 1] === "") parts.pop()
  const entries: RawEntry[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const meta = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(parts[i] ?? "")
    const file = parts[i + 1]
    if (!meta?.[1] || !meta[2] || !meta[3] || !file) {
      throw new DelegateError("upstream_error", "git reported the session changes in an unexpected form.", "Review the branch by hand before using it.", `raw diff entry ${i / 2}`)
    }
    entries.push({ srcMode: meta[1], dstMode: meta[2], status: meta[3], path: file })
  }
  return entries
}

/** True for a symlink or submodule on either side, or an executable file after the change. */
export function isHostExecutableMode(entry: RawEntry): boolean {
  return SPECIAL_MODES.has(entry.srcMode) || SPECIAL_MODES.has(entry.dstMode) || entry.dstMode === EXECUTABLE_MODE
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const
/** Dependency specs that install from somewhere other than the (cached) registry. */
const NON_REGISTRY_SPEC = /^\s*(file:|link:|git\+|git:|github:|https?:)/i

type PackageFacts = { scripts: string; bin: string; nonRegistryDeps: string }

/** The parts of a package.json that can run code on install or use; undefined when absent, null when unparseable. */
function packageFacts(json: string | undefined): PackageFacts | undefined | null {
  if (json === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const pkg = parsed as Record<string, unknown>
  const deps: string[] = []
  for (const field of DEPENDENCY_FIELDS) {
    const value = pkg[field]
    if (!value || typeof value !== "object") continue
    for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
      if (typeof spec === "string" && NON_REGISTRY_SPEC.test(spec)) deps.push(`${field}:${name}=${spec}`)
    }
  }
  return { scripts: JSON.stringify(pkg.scripts ?? null), bin: JSON.stringify(pkg.bin ?? null), nonRegistryDeps: JSON.stringify(deps.sort()) }
}

const NO_FACTS: PackageFacts = { scripts: "null", bin: "null", nonRegistryDeps: "[]" }

/**
 * True when a package.json change could make something run on the host: `scripts` or `bin`
 * differ, or the set of non-registry dependencies differs. Unparseable content fails closed.
 */
export function packageJsonRisky(before: string | undefined, after: string | undefined): boolean {
  const a = packageFacts(before)
  const b = packageFacts(after)
  if (a === null || b === null) return true
  const x = a ?? NO_FACTS
  const y = b ?? NO_FACTS
  return x.scripts !== y.scripts || x.bin !== y.bin || x.nonRegistryDeps !== y.nonRegistryDeps
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

/**
 * Reads the blob at `rev:file`. Only called for a side where git says the file exists, so
 * undefined means the read FAILED (timeout, git error), never "absent" (review N-8).
 */
export type BlobReader = (rev: string, file: string) => Promise<string | undefined>

const READ_FAILED = Symbol("read failed")

async function side(mode: string, rev: string, file: string, blob: BlobReader): Promise<string | undefined | typeof READ_FAILED> {
  if (mode === ABSENT_MODE) return undefined
  return (await blob(rev, file)) ?? READ_FAILED
}

/** The changed paths the owner must review before checking the branch out. */
export async function flagChanges(entries: readonly RawEntry[], base: string, branch: string, blob: BlobReader): Promise<string[]> {
  const flagged: string[] = []
  for (const entry of entries) {
    if (isHostExecutableMode(entry) || isHostExecutablePath(entry.path)) flagged.push(entry.path)
    else if (path.posix.basename(entry.path).toLowerCase() === "package.json") {
      const before = await side(entry.srcMode, base, entry.path, blob)
      const after = await side(entry.dstMode, branch, entry.path, blob)
      // A package.json that could not be read is reported: fail closed.
      if (before === READ_FAILED || after === READ_FAILED || packageJsonRisky(before, after)) flagged.push(entry.path)
    }
  }
  return flagged
}
