// Workspaces, part 1: hooks never run on the host, host-executable changes are reported, open() is
// atomic. Fixture (real git, simulated box): workspaces-fixture.ts. Part 2: workspaces-collect.test.ts.
// Pure helpers: workspaces-units.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ErrorCode } from "../src/shared/errors.ts"
import { code, git, posix, T, WorkspaceFixture } from "./workspaces-fixture.ts"

const fx = new WorkspaceFixture("ocd-ws-")
beforeAll(() => fx.setup(), T)
beforeEach(() => {
  fx.boxOverride = undefined
})
afterAll(() => fx.teardown())

describe("workspaces: collect never runs hooks planted in the box clone (red test)", () => {
  test(
    "planted post-checkout / post-merge / reference-transaction hooks stay silent; the branch arrives",
    async () => {
      const ws = await fx.workspaces().open(fx.hostRepo, "hook-test")
      expect(ws.branch).toBe("delegate/hook-test")
      expect(readFileSync(path.join(fx.boxClone("hook-test"), "README.md"), "utf8")).toBe("hello\n")
      expect(await fx.boxGit("hook-test", ["branch", "--show-current"])).toBe("delegate/hook-test")
      expect(fx.handoffFiles()).toEqual([])
      await fx.boxCommit("hook-test", { "src/a.txt": "work\n" }, "agent work")
      for (const hook of ["post-checkout", "post-merge", "reference-transaction"]) {
        const file = path.join(fx.boxClone("hook-test"), ".git", "hooks", hook)
        writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${posix(fx.marker)}"\n`)
        chmodSync(file, 0o755)
      }
      // Positive control: the planted hooks are live when git operates inside the clone.
      await fx.boxGit("hook-test", ["checkout", "-q", "-b", "probe"])
      await fx.boxGit("hook-test", ["checkout", "-q", "delegate/hook-test"])
      expect(existsSync(fx.marker)).toBe(true)
      rmSync(fx.marker)

      const tip = await fx.boxGit("hook-test", ["rev-parse", "delegate/hook-test"])
      const result = await fx.workspaces().collect(ws)
      expect(existsSync(fx.marker)).toBe(false)
      expect(result).toEqual({ branch: "delegate/hook-test", commits: 1, hostExecutableChanges: [] })
      expect(await git(fx.hostRepo, ["rev-parse", "delegate/hook-test"])).toBe(tip)
      expect(await git(fx.hostRepo, ["branch", "--show-current"])).toBe("main")
      expect(fx.handoffFiles()).toEqual([])
      expect(fx.incoming()).toEqual([])
    },
    T,
  )
})

describe("workspaces: OpenCode's own scratch is ignored in the clone", () => {
  test(
    ".system_generated/ is in .git/info/exclude: not untracked, never added",
    async () => {
      await fx.workspaces().open(fx.hostRepo, "scratch-test")
      const exclude = readFileSync(path.join(fx.boxClone("scratch-test"), ".git", "info", "exclude"), "utf8")
      expect(exclude.split(/\r?\n/)).toContain(".system_generated/")
      mkdirSync(path.join(fx.boxClone("scratch-test"), ".system_generated", "logs"), { recursive: true })
      writeFileSync(path.join(fx.boxClone("scratch-test"), ".system_generated", "logs", "diagnostics.log"), "{}\n")
      expect(await fx.boxGit("scratch-test", ["status", "--porcelain", "--untracked-files=all"])).toBe("")
    },
    T,
  )
})

describe("workspaces: host-executable changes are reported", () => {
  test(
    "paths, tool configs, agent files, package.json scripts, symlinks, submodules and exec bits are flagged",
    async () => {
      const workspaces = fx.workspaces()
      const ws = await workspaces.open(fx.hostRepo, "exec-test")
      await fx.boxCommit(
        "exec-test",
        {
          ".husky/pre-commit": "echo hi\n",
          ".githooks/pre-push": "echo hi\n",
          ".gitattributes": "* filter=x\n",
          "tools/run.PS1": "Write-Host hi\n",
          "tools/go.sh": "echo\n",
          "tools/go.cmd": "echo\n",
          "Makefile": "all:\n",
          ".envrc": "export X=1\n",
          ".mcp.json": "{}\n",
          "CLAUDE.md": "# rules\n",
          "pyproject.toml": "[project]\n",
          ".vscode/tasks.json": "{}\n",
          ".idea/runConfigurations/app.xml": "<x/>\n",
          "package.json": JSON.stringify({ name: "x", scripts: { test: "bun test", postinstall: "node evil.js" } }),
          "sub/package.json": JSON.stringify({ name: "sub", version: "2.0.0", scripts: { a: "b" } }),
          "README.md": "changed\n",
          "tools/build": "#!/bin/sh\n",
        },
        "risky",
      )
      await fx.boxCommit("exec-test", { "notes.txt": "x\n" }, "second")
      // Modes written straight to the index (works without symlink rights on Windows).
      writeFileSync(path.join(fx.tmp, "link-target"), "README.md")
      const blob = await fx.boxGit("exec-test", ["hash-object", "-w", path.join(fx.tmp, "link-target")])
      const base = await fx.boxGit("exec-test", ["rev-parse", "HEAD~2"])
      await fx.boxGit("exec-test", ["update-index", "--add", "--cacheinfo", `120000,${blob},docs/link`])
      await fx.boxGit("exec-test", ["update-index", "--add", "--cacheinfo", `160000,${base},vendor/sub`])
      await fx.boxGit("exec-test", ["update-index", "--chmod=+x", "tools/build"])
      await fx.boxGit("exec-test", ["commit", "-q", "-m", "modes"])
      const result = await workspaces.collect(ws)
      expect(result.commits).toBe(3)
      expect([...result.hostExecutableChanges].sort()).toEqual(
        [
          ".envrc", ".gitattributes", ".githooks/pre-push", ".husky/pre-commit", ".idea/runConfigurations/app.xml", ".mcp.json", ".vscode/tasks.json",
          "CLAUDE.md", "Makefile", "docs/link", "package.json", "pyproject.toml", "tools/build", "tools/go.cmd", "tools/go.sh", "tools/run.PS1", "vendor/sub",
        ].sort(),
      )
    },
    T,
  )
})

describe("workspaces: open is atomic and never collides", () => {
  test(
    "a second open of the same key is directory_busy and leaves the first intact",
    async () => {
      const workspaces = fx.workspaces()
      await workspaces.open(fx.hostRepo, "busy-key")
      expect(await code(workspaces.open(fx.hostRepo, "busy-key"))).toBe("directory_busy")
      expect(existsSync(path.join(fx.boxClone("busy-key"), "README.md"))).toBe(true)
      expect(fx.leftovers("busy-key")).toEqual(["busy-key"])
    },
    T,
  )

  test(
    "works when the owner's checked-out branch is delegate/<key>",
    async () => {
      await git(fx.hostRepo, ["checkout", "-q", "-b", "delegate/head-key"])
      try {
        const ws = await fx.workspaces().open(fx.hostRepo, "head-key")
        expect(await fx.boxGit("head-key", ["rev-parse", ws.branch])).toBe(await git(fx.hostRepo, ["rev-parse", "HEAD"]))
      } finally {
        await git(fx.hostRepo, ["checkout", "-q", "main"])
      }
    },
    T,
  )

  const failAt = (match: (a: string[]) => boolean, stderr: string) => (argv: string[]) => (match(argv) ? { code: 1, stdout: "", stderr } : undefined)
  const cases: Array<[string, (a: string[]) => boolean, string, ErrorCode]> = [
    ["the box is down at clone", (a) => a.includes("clone"), "Error response from daemon: No such container: opencode-delegate", "sandbox_unavailable"],
    ["checkout fails after the clone", (a) => a.includes("-B"), "fatal: bad object", "upstream_error"],
    ["the base check fails after the move", (a) => a.includes("rev-parse") && a.at(-1) === "HEAD", "fatal: broken", "upstream_error"],
  ]
  for (const [index, [label, match, stderr, expected]] of cases.entries()) {
    test(
      `a box failure (${label}) cleans up the temp and final folders, the bundle and the record`,
      async () => {
        fx.boxOverride = failAt(match, stderr)
        const key = `fail-case-${index}`
        expect(await code(fx.workspaces().open(fx.hostRepo, key))).toBe(expected)
        expect(fx.leftovers(key)).toEqual([])
        expect(fx.handoffFiles()).toEqual([])
        expect(existsSync(path.join(fx.tmp, "state", `${key}.json`))).toBe(false)
      },
      T,
    )
  }
})
