// Host git helpers for remote delegation.
import path from "node:path"
import { DelegateError } from "../shared/errors.ts"
import { cleanEnv, runCommand, type ExecResult } from "../supervisor/workspaces-exec.ts"

export type GitRunner = (argv: string[], cwd?: string, env?: NodeJS.ProcessEnv) => Promise<ExecResult>

export const defaultGitRunner: GitRunner = (argv, cwd, env) => runCommand(argv, env ?? cleanEnv(), 30_000, cwd)

/** Extract "owner/repo" from GitHub remote URLs (ssh or https). */
export function parseGitHubRepo(url: string): string | undefined {
  const trimmed = url.trim()
  const match = /(?:git@github\.com:|https?:\/\/github\.com\/)([^/]+\/[^/.]+)(?:\.git)?$/i.exec(trimmed)
  return match ? match[1] : undefined
}

/** Detect the remote GitHub repository name for a local directory. */
export async function detectRemoteRepo(hostRepo: string, run: GitRunner = defaultGitRunner): Promise<string> {
  const result = await run(["git", "-C", hostRepo, "remote", "get-url", "origin"])
  if (result.code === 0 && result.stdout.trim()) {
    const parsed = parseGitHubRepo(result.stdout)
    if (parsed) return parsed
  }
  // Fall back to directory basename if no origin or unparseable origin
  return path.basename(hostRepo)
}

/** Get the current HEAD commit hash of the local repository. */
export async function getHeadCommit(hostRepo: string, run: GitRunner = defaultGitRunner): Promise<string> {
  const result = await run(["git", "-C", hostRepo, "rev-parse", "HEAD"])
  if (result.code !== 0) {
    throw new DelegateError("upstream_error", "Failed to get HEAD commit of local repository.", "Ensure directory is a valid git repository.", result.stderr)
  }
  return result.stdout.trim()
}

/** Capture uncommitted changes (staged and unstaged) as a unified diff seed patch. */
export async function captureSeedPatch(hostRepo: string, run: GitRunner = defaultGitRunner): Promise<{ patch?: string; headSha: string }> {
  const headSha = await getHeadCommit(hostRepo, run)
  const diffResult = await run(["git", "-C", hostRepo, "diff", "HEAD"])
  if (diffResult.code !== 0) {
    throw new DelegateError("upstream_error", "Failed to generate git diff for uncommitted changes.", "Check repository status and retry.", diffResult.stderr)
  }
  const patch = diffResult.stdout.trim()
  return {
    patch: patch.length > 0 ? patch : undefined,
    headSha,
  }
}

/** Apply a unified patch to the local repository on branch delegate/<key> without touching the working tree. */
export async function applyRemotePatch(
  hostRepo: string,
  branch: string,
  baseSha: string,
  patch: string,
  run: GitRunner = defaultGitRunner,
): Promise<{ branch: string; filesChanged: string[] }> {
  if (!patch.trim()) {
    return { branch, filesChanged: [] }
  }

  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const gitDir = path.join(hostRepo, ".git")
  const tempIndex = path.join(gitDir, `delegate-index-${nonce}`)
  const tempPatch = path.join(gitDir, `delegate-${nonce}.patch`)

  await Bun.write(tempPatch, patch)
  const indexEnv = { ...cleanEnv(), GIT_INDEX_FILE: tempIndex }

  try {
    // 1. Read baseSha tree into the isolated temp index
    const readTreeRes = await run(["git", "--git-dir", gitDir, "read-tree", baseSha], hostRepo, indexEnv)
    if (readTreeRes.code !== 0) {
      throw new DelegateError("upstream_error", `Failed to read tree for base ${baseSha}.`, "Verify git history.", readTreeRes.stderr)
    }

    // 2. Apply patch to the isolated temp index
    const applyRes = await run(["git", "--git-dir", gitDir, "apply", "--cached", "--whitespace=nowarn", tempPatch], hostRepo, indexEnv)
    if (applyRes.code !== 0) {
      throw new DelegateError("branch_diverged", "Remote patch cannot be cleanly applied to current workspace base.", "Check for conflicting local changes.", applyRes.stderr)
    }

    // 3. Write tree object from the isolated temp index
    const writeTreeRes = await run(["git", "--git-dir", gitDir, "write-tree"], hostRepo, indexEnv)
    if (writeTreeRes.code !== 0) {
      throw new DelegateError("upstream_error", "Failed to write git tree from applied patch.", "Check git repository state.", writeTreeRes.stderr)
    }
    const treeSha = writeTreeRes.stdout.trim()

    // 4. Create commit object from tree
    const commitRes = await run(["git", "--git-dir", gitDir, "commit-tree", treeSha, "-p", baseSha, "-m", `feat(delegate): remote task completion`], hostRepo)
    if (commitRes.code !== 0) {
      throw new DelegateError("upstream_error", "Failed to create git commit for remote patch.", "Check git repository state.", commitRes.stderr)
    }
    const commitSha = commitRes.stdout.trim()

    // 5. Update branch ref
    const updateRefRes = await run(["git", "-C", hostRepo, "update-ref", `refs/heads/${branch}`, commitSha], hostRepo)
    if (updateRefRes.code !== 0) {
      throw new DelegateError("upstream_error", `Failed to update branch ref for ${branch}.`, "Check git state.", updateRefRes.stderr)
    }

    // 6. Query changed files
    const diffRes = await run(["git", "-C", hostRepo, "diff", "--name-only", `${baseSha}..${branch}`, "--"], hostRepo)
    const filesChanged = diffRes.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)

    return { branch, filesChanged }
  } finally {
    try {
      const { unlinkSync } = await import("node:fs")
      try { unlinkSync(tempPatch) } catch {}
      try { unlinkSync(tempIndex) } catch {}
    } catch {
      // Ignore cleanup error
    }
  }
}
