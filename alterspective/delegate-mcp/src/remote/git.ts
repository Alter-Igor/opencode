// Host git helpers for remote delegation.
import path from "node:path"
import { DelegateError } from "../shared/errors.ts"
import { cleanEnv, runCommand, type ExecResult } from "../supervisor/workspaces-exec.ts"

export type GitRunner = (argv: string[], cwd?: string) => Promise<ExecResult>

export const defaultGitRunner: GitRunner = (argv, cwd) => runCommand(argv, cleanEnv(), 30_000, cwd)

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

/** Apply a unified patch to the local repository on branch delegate/<key>. */
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

  // Ensure branch exists starting from baseSha
  const branchCheck = await run(["git", "-C", hostRepo, "rev-parse", "--verify", branch])
  if (branchCheck.code !== 0) {
    const createBranch = await run(["git", "-C", hostRepo, "branch", branch, baseSha])
    if (createBranch.code !== 0) {
      throw new DelegateError("upstream_error", `Failed to create branch ${branch} from ${baseSha}.`, "Check git state.", createBranch.stderr)
    }
  }

  // Switch to branch temporarily or apply patch via git apply to tree
  // Using git apply directly
  const applyRes = await run(["git", "-C", hostRepo, "apply", "--whitespace=nowarn"], hostRepo)
  // Wait, git apply reads from stdin or file. Let's pass via temp file or git apply --check.
  // Using node:fs to write a temporary patch file in hostRepo or temp dir
  const tempPatch = path.join(hostRepo, `.git`, `delegate-${Date.now()}.patch`)
  await Bun.write(tempPatch, patch)

  try {
    const checkRes = await run(["git", "-C", hostRepo, "apply", "--check", "--whitespace=nowarn", tempPatch])
    if (checkRes.code !== 0) {
      throw new DelegateError("branch_diverged", "Remote patch cannot be cleanly applied to current workspace.", "Check for conflicting local changes.", checkRes.stderr)
    }

    const applyResult = await run(["git", "-C", hostRepo, "apply", "--whitespace=nowarn", tempPatch])
    if (applyResult.code !== 0) {
      throw new DelegateError("upstream_error", "Failed to apply remote patch.", "Check git apply error.", applyResult.stderr)
    }

    // Read list of changed files from the patch
    const numstat = await run(["git", "-C", hostRepo, "apply", "--numstat", tempPatch])
    const filesChanged = numstat.stdout
      .split(/\r?\n/)
      .map((line) => line.split(/\t/)[2]?.trim())
      .filter((file): file is string => Boolean(file))

    return { branch, filesChanged }
  } finally {
    try {
      const { unlinkSync } = await import("node:fs")
      unlinkSync(tempPatch)
    } catch {
      // Ignore cleanup error
    }
  }
}
