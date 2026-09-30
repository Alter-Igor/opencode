// MOD-01: which OpenCode build the box runs (review A-06, VER-DEV-01).
// Tag = <package version>-<git short sha>, plus -dirty-<hash> when the build context has
// uncommitted changes, so a changed fork always gets a new image and a local build is never
// mistaken for a clean one. The build context is read from the box's Dockerfile.dockerignore
// (its `!` lines), so the dirty check and the Docker build always look at the same files.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { DelegateError } from "../shared/errors.ts"
import { imageTag, type Exec } from "./docker.ts"

export type BuildIdentity = { version: string; sha: string; dirty?: string; image: string; opencodeVersion: string }

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const MAX_HASHED_UNTRACKED = 2000

function unavailable(message: string, detail: string): DelegateError {
  return new DelegateError("sandbox_unavailable", message, "Check the OpenCode checkout (git and packages/opencode/package.json), then retry.", detail)
}

/** Repo-relative folder of the box Dockerfile (forward slashes: it is also a git pathspec). */
const BOX_DIR = "alterspective/delegate-mcp/docker/box"

export function dockerignorePath(repoRoot: string): string {
  return path.join(repoRoot, ...BOX_DIR.split("/"), "Dockerfile.dockerignore")
}

/** git pathspecs for the build context: `!x` lines are included, other patterns excluded. */
export function buildContextPathspecs(dockerignore: string): string[] {
  const include: string[] = []
  const exclude: string[] = []
  for (const raw of dockerignore.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line === "*") continue
    if (line.startsWith("!")) include.push(line.slice(1))
    else exclude.push(`:(exclude,glob)${line}`, `:(exclude,glob)${line}/**`)
  }
  return [...include, ...exclude]
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

export async function buildIdentity(repoRoot: string, imageName: string, exec: Exec): Promise<BuildIdentity> {
  const version = await readVersion(repoRoot)
  const sha = (await git(exec, repoRoot, ["rev-parse", "--short=7", "HEAD"])).trim()
  let dockerignore: string
  try {
    dockerignore = await readFile(dockerignorePath(repoRoot), "utf8")
  } catch (error) {
    throw unavailable("The sandbox build file list could not be read.", `${(error as NodeJS.ErrnoException).code ?? "error"} ${dockerignorePath(repoRoot)}`)
  }
  // The Dockerfile and its ignore file shape the image too, though they are not copied into it.
  const dirty = await dirtyHash(exec, repoRoot, [...buildContextPathspecs(dockerignore), BOX_DIR])
  const image = imageTag(imageName, version, sha, dirty)
  const opencodeVersion = `${version}-alterspective.${sha}${dirty ? `.dirty.${dirty}` : ""}`
  return { version, sha, dirty, image, opencodeVersion }
}
