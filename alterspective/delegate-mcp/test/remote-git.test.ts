import { describe, expect, it } from "bun:test"
import { applyRemotePatch, captureSeedPatch, detectRemoteRepo, getHeadCommit, parseGitHubRepo, type GitRunner } from "../src/remote/git.ts"

describe("remote git helpers", () => {
  it("parses github repo correctly from different url formats", () => {
    expect(parseGitHubRepo("git@github.com:Alterspective-Engine/svc-coding-agent.git")).toBe("Alterspective-Engine/svc-coding-agent")
    expect(parseGitHubRepo("git@github.com:Alter-Igor/opencode")).toBe("Alter-Igor/opencode")
    expect(parseGitHubRepo("https://github.com/Alterspective-Engine/svc-coding-agent.git")).toBe("Alterspective-Engine/svc-coding-agent")
    expect(parseGitHubRepo("https://github.com/Alterspective-Engine/svc-coding-agent")).toBe("Alterspective-Engine/svc-coding-agent")
    expect(parseGitHubRepo("https://other-vcs.com/repo")).toBeUndefined()
  })

  it("detects remote repo using git runner", async () => {
    const mockRunner: GitRunner = async (argv) => {
      expect(argv).toEqual(["git", "-C", "/test/repo", "remote", "get-url", "origin"])
      return { code: 0, stdout: "git@github.com:Alterspective/test-repo.git\n", stderr: "" }
    }
    const repo = await detectRemoteRepo("/test/repo", mockRunner)
    expect(repo).toBe("Alterspective/test-repo")
  })

  it("captures seed patch when uncommitted diff exists", async () => {
    const mockRunner: GitRunner = async (argv) => {
      if (argv.includes("rev-parse")) {
        return { code: 0, stdout: "abc123456789\n", stderr: "" }
      }
      if (argv.includes("diff")) {
        return { code: 0, stdout: "diff --git a/file b/file\n+new line\n", stderr: "" }
      }
      return { code: 0, stdout: "", stderr: "" }
    }

    const { patch, headSha } = await captureSeedPatch("/test/repo", mockRunner)
    expect(headSha).toBe("abc123456789")
    expect(patch).toContain("+new line")
  })

  it("captures undefined patch when worktree is clean", async () => {
    const mockRunner: GitRunner = async (argv) => {
      if (argv.includes("rev-parse")) {
        return { code: 0, stdout: "abc123456789\n", stderr: "" }
      }
      if (argv.includes("diff")) {
        return { code: 0, stdout: "", stderr: "" }
      }
      return { code: 0, stdout: "", stderr: "" }
    }

    const { patch, headSha } = await captureSeedPatch("/test/repo", mockRunner)
    expect(headSha).toBe("abc123456789")
    expect(patch).toBeUndefined()
  })

  it("applies remote patch cleanly", async () => {
    const executed: string[][] = []
    const mockRunner: GitRunner = async (argv) => {
      executed.push(argv)
      if (argv.includes("--absolute-git-dir")) {
        return { code: 0, stdout: "/test/repo/.git\n", stderr: "" }
      }
      if (argv.includes("write-tree")) {
        return { code: 0, stdout: "tree-sha-123\n", stderr: "" }
      }
      if (argv.includes("commit-tree")) {
        return { code: 0, stdout: "commit-sha-456\n", stderr: "" }
      }
      if (argv.includes("diff") && argv.includes("--name-only")) {
        return { code: 0, stdout: "src/file.ts\n", stderr: "" }
      }
      return { code: 0, stdout: "", stderr: "" }
    }

    const res = await applyRemotePatch("/test/repo", "delegate/test-branch", "base-sha", "diff --git a/src/file.ts b/src/file.ts", mockRunner)
    expect(res.branch).toBe("delegate/test-branch")
    expect(res.filesChanged).toEqual(["src/file.ts"])
    expect(executed.find((argv) => argv.includes("read-tree"))).toContain("/test/repo/.git")
  })
})
