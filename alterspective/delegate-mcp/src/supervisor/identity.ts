// MOD-01: which OpenCode build the box runs (review A-06, VER-DEV-01).
// Tag = <package version>-<12 hex content hash of the build inputs>, plus -dirty-<hash> when those
// inputs have uncommitted changes. The content hash comes from `git ls-tree -r HEAD` over the
// inputs (blob ids are content hashes), so a commit that changes nothing the images are built
// from (docs, the bridge's own src/) keeps the same tag and the running box is reused. The build
// context is read from the box's Dockerfile.dockerignore (its `!` lines and exclude patterns), so
// the hash, the dirty check and the Docker build always look at the same files.
// The git sha is still stamped into the binary and the image's OCI version label (VER-BUILD-01),
// for information only: it never decides reuse.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { DelegateError } from "../shared/errors.ts"
import { imageTag, type Exec } from "./docker.ts"

export type BuildIdentity = { version: string; sha: string; content: string; dirty?: string; image: string; opencodeVersion: string }

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const MAX_HASHED_UNTRACKED = 2000

function unavailable(message: string, detail: string): DelegateError {
  return new DelegateError("sandbox_unavailable", message, "Check the OpenCode checkout (git and packages/opencode/package.json), then retry.", detail)
}

/** Repo-relative folder of the box Dockerfile (forward slashes: it is also a git pathspec). */
const BOX_DIR = "alterspective/delegate-mcp/docker/box"
/**
 * Everything the running set is built from (review N-9): the box, egress and cache Dockerfiles
 * and configs, and compose.yaml. A change anywhere here gives a new tag, so the egress and cache
 * images (named after the box image in compose.yaml) are rebuilt too.
 */
export const DOCKER_DIR = "alterspective/delegate-mcp/docker"
/** MOD-05: the inbox sidecar's build context (compose.yaml `build: ../inbox-sidecar`), outside docker/. */
export const INBOX_SIDECAR_DIR = "alterspective/delegate-mcp/inbox-sidecar"
// profile-tools/ is not an image input: it is copied into the profile folder at start
// (profile.ts), so the profile hash already covers it.

export function dockerignorePath(repoRoot: string): string {
  return path.join(repoRoot, ...BOX_DIR.split("/"), "Dockerfile.dockerignore")
}

export type BuildContext = { include: string[]; exclude: string[] }

/** The allowlist (`!x` lines) and the exclude patterns of a dockerignore that starts with `*`. */
export function parseDockerignore(dockerignore: string): BuildContext {
  const include: string[] = []
  const exclude: string[] = []
  for (const raw of dockerignore.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line === "*") continue
    if (line.startsWith("!")) include.push(line.slice(1))
    else exclude.push(line)
  }
  return { include, exclude }
}

/** git pathspecs for the build context: `!x` lines are included, other patterns excluded. */
export function buildContextPathspecs(dockerignore: string): string[] {
  const { include, exclude } = parseDockerignore(dockerignore)
  return [...include, ...exclude.flatMap((line) => [`:(exclude,glob)${line}`, `:(exclude,glob)${line}/**`])]
}

/** A dockerignore pattern as a regexp over repo-relative paths; it also matches everything below a match. */
export function globToRegExp(pattern: string): RegExp {
  let out = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? ""
    if (pattern.startsWith("**/", i)) {
      out += "(?:.*/)?"
      i += 2
    } else if (pattern.startsWith("**", i)) {
      out += ".*"
      i += 1
    } else if (char === "*") out += "[^/]*"
    else if (char === "?") out += "[^/]"
    else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${out}(?:/.*)?$`)
}

async function readVersion(repoRoot: string): Promise<string> {
  const file = path.join(repoRoot, "packages", "opencode", "package.json")
  let version: unknown
  try {
    version = (JSON.parse(await readFile(file, "utf8")) as { version?: unknown }).version
  } catch (error) {
    throw unavailable("The OpenCode package version could not be read.", `${(error as NodeJS.ErrnoException).code ?? "parse error"} ${file}`)
  }
  if (typeof version !== "string" || !VERSION.test(version))
    throw unavailable("The OpenCode package version is missing or not a version number.", `version=${String(version).slice(0, 40)} in ${file}`)
  return version
}

async function git(exec: Exec, repoRoot: string, args: string[]): Promise<string> {
  const result = await exec(["git", "-C", repoRoot, ...args], { timeoutMs: 60_000 })
  if (result.code !== 0) throw unavailable("git could not read the OpenCode checkout.", `git ${args[0]} exit ${result.code}: ${result.stderr.trim().slice(0, 300)}`)
  return result.stdout
}

/**
 * 12 hex of the committed build inputs: every `<mode> <type> <blob id>\t<path>` entry of HEAD under
 * `include`, less the excluded patterns. ls-tree takes no pathspec magic, so excludes are applied here.
 */
export async function contentHash(exec: Exec, repoRoot: string, context: BuildContext): Promise<string> {
  const listing = await git(exec, repoRoot, ["ls-tree", "-r", "-z", "--full-tree", "HEAD", "--", ...context.include])
  const excluded = context.exclude.map(globToRegExp)
  const entries = listing
    .split("\0")
    .filter((entry) => entry.includes("\t"))
    .filter((entry) => !excluded.some((re) => re.test(entry.slice(entry.indexOf("\t") + 1))))
    .sort()
  const hash = createHash("sha256")
  for (const entry of entries) hash.update(entry).update("\0")
  return hash.digest("hex").slice(0, 12)
}

/** Short hash of the uncommitted build-context changes, or undefined when clean. */
export async function dirtyHash(exec: Exec, repoRoot: string, pathspecs: string[]): Promise<string | undefined> {
  const status = await git(exec, repoRoot, ["status", "--porcelain", "--untracked-files=all", "--", ...pathspecs])
  if (!status.trim()) return undefined
  const hash = createHash("sha256").update(await git(exec, repoRoot, ["diff", "HEAD", "--binary", "--", ...pathspecs])).update("\0")
  const untracked = (await git(exec, repoRoot, ["ls-files", "--others", "--exclude-standard", "--", ...pathspecs])).split("\n").filter(Boolean).sort()
  for (const [index, name] of untracked.entries()) {
    hash.update(name).update("\0")
    // Content too, so editing an untracked file also changes the tag (names only past the cap).
    if (index < MAX_HASHED_UNTRACKED) hash.update(await readFile(path.join(repoRoot, name)).catch(() => Buffer.from("unreadable"))).update("\0")
  }
  return hash.digest("hex").slice(0, 12)
}

async function readDockerignore(repoRoot: string): Promise<string> {
  try {
    return await readFile(dockerignorePath(repoRoot), "utf8")
  } catch (error) {
    throw unavailable("The sandbox build file list could not be read.", `${(error as NodeJS.ErrnoException).code ?? "error"} ${dockerignorePath(repoRoot)}`)
  }
}

export async function buildIdentity(repoRoot: string, imageName: string, exec: Exec): Promise<BuildIdentity> {
  const version = await readVersion(repoRoot)
  const sha = (await git(exec, repoRoot, ["rev-parse", "--short=7", "HEAD"])).trim()
  const dockerignore = await readDockerignore(repoRoot)
  const parsed = parseDockerignore(dockerignore)
  // The docker/ folder and the inbox sidecar shape the images too, though not copied into the box (N-9).
  const content = await contentHash(exec, repoRoot, { include: [...parsed.include, DOCKER_DIR, INBOX_SIDECAR_DIR], exclude: parsed.exclude })
  const dirty = await dirtyHash(exec, repoRoot, [...buildContextPathspecs(dockerignore), DOCKER_DIR, INBOX_SIDECAR_DIR])
  const image = imageTag(imageName, version, content, dirty)
  const opencodeVersion = `${version}-alterspective.${sha}${dirty ? `.dirty.${dirty}` : ""}`
  return { version, sha, content, dirty, image, opencodeVersion }
}
