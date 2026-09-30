// Workspaces are tested against real git on scratch repos under %TEMP% (never inside C:\GitHub).
// The box is simulated: `boxExec` runs git locally with /handoff and /sessions mapped to temp folders and
// with no global/system git config, standing in for `docker exec <box> ...`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultConfig } from "../src/shared/config.ts"
import { DelegateError } from "../src/shared/errors.ts"
import {
  canonicalPath,
  cleanEnv,
  createWorkspaces,
  isHostExecutablePath,
  parseSubst,
  runCommand,
  scriptsChanged,
  type Exec,
} from "../src/supervisor/workspaces.ts"

const T = 60_000
let tmp = ""
let root = ""
let hostRepo = ""
let handoff = ""
let sessions = ""
let marker = ""
let boxEnv: NodeJS.ProcessEnv = {}

const posix = (p: string) => p.replace(/\\/g, "/")
const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false"]

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommand(["git", "-C", cwd, ...identity, ...args], env)
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout.trim()
}

const boxExec: Exec = (argv) =>
  runCommand(
    argv.map((a) => a.replace(/^\/handoff(?=\/|$)/, posix(handoff)).replace(/^\/sessions(?=\/|$)/, posix(sessions))),
    boxEnv,
  )

function makeWorkspaces(extra: { substMap?: () => Promise<Record<string, string>> } = {}) {
  const config = { ...defaultConfig({}), home: path.join(tmp, "home"), roots: [root] }
  return createWorkspaces({ config, container: "unused-in-tests", handoffDir: handoff, stateDir: path.join(tmp, "state"), boxExec, substMap: extra.substMap ?? (async () => ({})) })
}

const boxClone = (key: string) => path.join(sessions, key)

async function boxCommit(key: string, files: Record<string, string>, message: string) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(boxClone(key), file)), { recursive: true })
    writeFileSync(path.join(boxClone(key), file), content)
  }
  await git(boxClone(key), ["add", "-A"], boxEnv)
  await git(boxClone(key), ["commit", "-q", "-m", message], boxEnv)
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "ocd-ws-"))
  root = path.join(tmp, "root")
  hostRepo = path.join(root, "repo")
  handoff = path.join(tmp, "handoff")
  sessions = path.join(tmp, "sessions")
  marker = path.join(tmp, "HOOK-RAN")
  mkdirSync(hostRepo, { recursive: true })
  mkdirSync(sessions, { recursive: true })
  const emptyGlobal = path.join(tmp, "empty.gitconfig")
  writeFileSync(emptyGlobal, "")
  boxEnv = { ...cleanEnv(), GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: "1" }
  await git(hostRepo, ["init", "-q", "-b", "main"])
  writeFileSync(path.join(hostRepo, "README.md"), "hello\n")
  writeFileSync(path.join(hostRepo, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test" } }, null, 2))
  mkdirSync(path.join(hostRepo, "sub"))
  writeFileSync(path.join(hostRepo, "sub", "package.json"), JSON.stringify({ name: "sub", version: "1.0.0", scripts: { a: "b" } }))
  await git(hostRepo, ["add", "-A"])
  await git(hostRepo, ["commit", "-q", "-m", "base"])
}, T)

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe("workspaces: collect never runs hooks planted in the box clone (red test)", () => {
  test(
    "planted post-checkout / post-merge / reference-transaction hooks stay silent; the branch arrives",
    async () => {
      const ws = await makeWorkspaces().open(hostRepo, "hook-test")
      expect(ws.branch).toBe("delegate/hook-test")
      expect(existsSync(path.join(handoff, "hook-test-in.bundle"))).toBe(false)
      await boxCommit("hook-test", { "src/a.txt": "work\n" }, "agent work")
      for (const hook of ["post-checkout", "post-merge", "reference-transaction"]) {
        const file = path.join(boxClone("hook-test"), ".git", "hooks", hook)
        writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${posix(marker)}"\n`)
        chmodSync(file, 0o755)
      }
      // Positive control: the planted hooks are live when git operates inside the clone.
      await git(boxClone("hook-test"), ["checkout", "-q", "-b", "probe"], boxEnv)
      await git(boxClone("hook-test"), ["checkout", "-q", "delegate/hook-test"], boxEnv)
      expect(existsSync(marker)).toBe(true)
      rmSync(marker)

      const tip = await git(boxClone("hook-test"), ["rev-parse", "delegate/hook-test"], boxEnv)
      const result = await makeWorkspaces().collect(ws)
      expect(existsSync(marker)).toBe(false)
      expect(result).toEqual({ branch: "delegate/hook-test", commits: 1, hostExecutableChanges: [] })
      expect(await git(hostRepo, ["rev-parse", "delegate/hook-test"])).toBe(tip)
      expect(await git(hostRepo, ["branch", "--show-current"])).toBe("main")
      expect(existsSync(path.join(handoff, "hook-test-out.bundle"))).toBe(false)
    },
    T,
  )
})

describe("workspaces: host-executable changes are reported", () => {
  test(
    "hooks dirs, .git* files, scripts, Makefile and package.json scripts are flagged; plain files are not",
    async () => {
      const workspaces = makeWorkspaces()
      const ws = await workspaces.open(hostRepo, "exec-test")
      await boxCommit(
        "exec-test",
        {
          ".husky/pre-commit": "echo hi\n",
          ".githooks/pre-push": "echo hi\n",
          ".gitattributes": "* filter=x\n",
          "tools/run.PS1": "Write-Host hi\n",
          "tools/go.sh": "echo\n",
          "tools/go.cmd": "echo\n",
          "Makefile": "all:\n",
          "package.json": JSON.stringify({ name: "x", scripts: { test: "bun test", postinstall: "node evil.js" } }),
          "sub/package.json": JSON.stringify({ name: "sub", version: "2.0.0", scripts: { a: "b" } }),
          "README.md": "changed\n",
        },
        "risky",
      )
      await boxCommit("exec-test", { "notes.txt": "x\n" }, "second")
      const result = await workspaces.collect(ws)
      expect(result.commits).toBe(2)
      expect([...result.hostExecutableChanges].sort()).toEqual(
        [".gitattributes", ".githooks/pre-push", ".husky/pre-commit", "Makefile", "package.json", "tools/go.cmd", "tools/go.sh", "tools/run.PS1"].sort(),
      )
    },
    T,
  )
})

describe("workspaces: folder validation", () => {
  const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as DelegateError).code

  test(
    "refuses folders outside the roots, '..' escapes, and non-repos",
    async () => {
      const outside = path.join(tmp, "outside")
      mkdirSync(outside, { recursive: true })
      await git(outside, ["init", "-q"])
      mkdirSync(path.join(root, "plain"), { recursive: true })
      const workspaces = makeWorkspaces()
      expect(await code(workspaces.resolveRepo(outside))).toBe("directory_invalid")
      expect(await code(workspaces.resolveRepo(`${root}\\repo\\..\\..\\outside`))).toBe("directory_invalid")
      expect(await code(workspaces.resolveRepo(`${root}/repo/../repo`))).toBe("directory_invalid")
      expect(await code(workspaces.resolveRepo(path.join(root, "plain")))).toBe("directory_invalid")
      expect(await code(workspaces.resolveRepo(path.join(root, "missing")))).toBe("directory_invalid")
      expect(await code(workspaces.open(hostRepo, "Bad_Key"))).toBe("invalid_input")
      expect(await code(workspaces.open(hostRepo, "abc"))).toBe("invalid_input")
    },
    T,
  )

  test(
    "normalises case, subdirectories and drive substitutions to the same repo",
    async () => {
      const expected = canonicalPath(hostRepo, {})
      const workspaces = makeWorkspaces({ substMap: async () => ({ "Q:": root }) })
      expect(await workspaces.resolveRepo(path.join(hostRepo, "sub"))).toBe(expected)
      if (process.platform === "win32") {
        expect(await workspaces.resolveRepo(hostRepo.toUpperCase())).toBe(expected)
        expect(await workspaces.resolveRepo("q:\\repo")).toBe(expected)
      }
    },
    T,
  )

  test("collect without a host record is not_found", async () => {
    const ws = { sessionKey: "never-opened", hostRepo, boxPath: "/sessions/never-opened", branch: "delegate/never-opened" }
    expect(await code(makeWorkspaces().collect(ws))).toBe("not_found")
  })
})

describe("workspaces: helpers", () => {
  test("parseSubst reads `subst` output", () => {
    expect(parseSubst("T:\\: => X:\\some-dir\r\nW:\\: => C:\\GitHub\\x\r\n")).toEqual({ "T:": "X:\\some-dir", "W:": "C:\\GitHub\\x" })
  })

  test("isHostExecutablePath", () => {
    for (const p of [".husky/x", "a/.githooks/y", ".gitmodules", ".github/workflows/ci.yml", "Makefile", "x/GNUmakefile", "a.bat", "b.CMD", "c.ps1", "d.sh"]) {
      expect(isHostExecutablePath(p)).toBe(true)
    }
    for (const p of ["README.md", "src/index.ts", "husky.md", "shell.txt", "package.json"]) expect(isHostExecutablePath(p)).toBe(false)
  })

  test("scriptsChanged fails closed on unparseable package.json", () => {
    expect(scriptsChanged('{"scripts":{"a":"b"}}', '{"scripts":{"a":"b"},"version":"2"}')).toBe(false)
    expect(scriptsChanged('{"scripts":{"a":"b"}}', '{"scripts":{"a":"c"}}')).toBe(true)
    expect(scriptsChanged(undefined, '{"name":"x"}')).toBe(false)
    expect(scriptsChanged(undefined, '{"scripts":{}}')).toBe(true)
    expect(scriptsChanged("{bad", "{bad")).toBe(true)
  })
})
