// MOD-01 workspaces: which changes on delegate/<key> could run something on the owner's host
// (reviews A-15, C-3). Reported to the owner by collect(); never acted on by the bridge.
// Classes:
//   paths      - hook/config folders, tool configs, agent instruction files, build and script files;
//   modes      - symlinks (120000), submodules (160000) and executable files (100755);
//   package.json - only when `scripts` changed (install/test hooks).
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
  "agents.md",
  "claude.md",
  "gemini.md",
  "makefile",
  "gnumakefile",
])

/** Folder names (lower case) whose contents a tool on the host reads and may execute. */
const EXEC_SEGMENTS = new Set([".claude", ".vscode", ".devcontainer", ".githooks", ".husky"])

const EXEC_EXTENSIONS = /\.(ps1|bat|cmd|sh)$/
/** Modes that change what the path IS: symlink, submodule (gitlink). */
const SPECIAL_MODES = new Set(["120000", "160000"])
const EXECUTABLE_MODE = "100755"

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

/** Reads a blob at `rev:file`; undefined when it does not exist there. */
export type BlobReader = (rev: string, file: string) => Promise<string | undefined>

/** The changed paths the owner must review before checking the branch out. */
export async function flagChanges(entries: readonly RawEntry[], base: string, branch: string, blob: BlobReader): Promise<string[]> {
  const flagged: string[] = []
  for (const entry of entries) {
    if (isHostExecutableMode(entry) || isHostExecutablePath(entry.path)) flagged.push(entry.path)
    else if (path.posix.basename(entry.path).toLowerCase() === "package.json") {
      if (scriptsChanged(await blob(base, entry.path), await blob(branch, entry.path))) flagged.push(entry.path)
    }
  }
  return flagged
}
