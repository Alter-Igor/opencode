import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { applyRemotePatch, defaultGitRunner } from "../src/remote/git.ts"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await defaultGitRunner(["git", "-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args])
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout.trim()
}

async function repoWithWorktree(): Promise<{ main: string; worktree: string; base: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "delegate-wt-"))
  dirs.push(root)
  const main = path.join(root, "main")
  const worktree = path.join(root, "wt")
  await defaultGitRunner(["git", "init", "-q", "-b", "dev", main])
  writeFileSync(path.join(main, "a.txt"), "one\n")
  await git(main, "add", "a.txt")
  await git(main, "commit", "-q", "-m", "init")
  await git(main, "worktree", "add", "-q", "-b", "feature", worktree)
  return { main, worktree, base: await git(worktree, "rev-parse", "HEAD") }
}

const patch = ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1,2 @@", " one", "+two", ""].join("\n")

describe("applyRemotePatch with real git", () => {
  it("collects into a linked worktree, where .git is a file", async () => {
    const { main, worktree, base } = await repoWithWorktree()

    const result = await applyRemotePatch(worktree, "delegate/wt-test", base, patch)

    expect(result.filesChanged).toEqual(["a.txt"])
    expect(await git(main, "show", "delegate/wt-test:a.txt")).toBe("one\ntwo")
    expect(await git(worktree, "status", "--porcelain")).toBe("")
  })

  it("still collects into a normal checkout", async () => {
    const { main, base } = await repoWithWorktree()

    const result = await applyRemotePatch(main, "delegate/main-test", base, patch)

    expect(result.filesChanged).toEqual(["a.txt"])
    expect(await git(main, "rev-parse", "delegate/main-test^")).toBe(base)
  })
})
