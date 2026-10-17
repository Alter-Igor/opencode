// Workspaces, part 1: hooks never run on the host, host-executable changes are reported, open() is
// atomic. Fixture (real git, simulated box): workspaces-fixture.ts. Part 2: workspaces-collect.test.ts.
// Pure helpers: workspaces-units.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ErrorCode } from "../src/shared/errors.ts"
import { grepPathspecs, MAX_PATHSPEC_CHARS, runCommand, TIMEOUT_CODE, type ExecResult } from "../src/supervisor/workspaces.ts"
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
      expect(result).toEqual({ branch: "delegate/hook-test", commits: 1, hostExecutableChanges: [], mirrorAddressFiles: [] })
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

describe("workspaces: default git author identity (#138)", () => {
  test(
    "cloneAt sets default user.name and user.email so commits work out of the box",
    async () => {
      await fx.workspaces().open(fx.hostRepo, "identity-test")
      const config = readFileSync(path.join(fx.boxClone("identity-test"), ".git", "config"), "utf8")
      expect(config).toContain("name = OpenCode Delegate (Synapse)")
      expect(config).toContain("email = opencode-delegate@users.noreply.github.com")
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

describe("workspaces: collect names files that still hold a cache address (#162)", () => {
  test(
    "only files whose branch version has the address are listed",
    async () => {
      const workspaces = fx.workspaces()
      const ws = await workspaces.open(fx.hostRepo, "mirror-test")
      await fx.boxCommit(
        "mirror-test",
        {
          "package-lock.json": '{"resolved": "http://npm-cache:4873/a/-/a-1.0.0.tgz"}\n',
          "py/uv.lock": 'source = { registry = "http://pypi-cache:5000/index/" }\n',
          "fixed.json": '{"url": "http://npm-cache:4873/b"}\n',
          "notes.md": "no address here\n",
        },
        "lockfiles",
      )
      await fx.boxCommit("mirror-test", { "fixed.json": '{"url": "https://registry.npmjs.org/b"}\n' }, "fix one")
      const result = await workspaces.collect(ws)
      expect([...(result.mirrorAddressFiles ?? [])].sort()).toEqual(["package-lock.json", "py/uv.lock"])
    },
    T,
  )

  test(
    "a repo that marks lockfiles -diff or binary does not hide them; a glob-like name is a plain name",
    async () => {
      // Host-side git reads attributes from the owner's checkout, so they go in the host repo.
      const attributes = path.join(fx.hostRepo, ".git", "info", "attributes")
      mkdirSync(path.dirname(attributes), { recursive: true })
      writeFileSync(attributes, "*.lock -diff\n*.bin binary\n")
      try {
        const workspaces = fx.workspaces()
        const ws = await workspaces.open(fx.hostRepo, "mirror-binary")
        await fx.boxCommit(
          "mirror-binary",
          {
            "uv.lock": 'source = { registry = "http://pypi-cache:5000/index/" }\n',
            "deps.bin": "http://npm-cache:4873/a\n",
            "[i]": "http://npm-cache:4873/b\n",
          },
          "lockfiles",
        )
        const result = await workspaces.collect(ws)
        expect([...(result.mirrorAddressFiles ?? [])].sort()).toEqual(["[i]", "deps.bin", "uv.lock"])
      } finally {
        rmSync(attributes, { force: true })
      }
    },
    T,
  )

  test(
    "a changed file is listed when its address line is old and untouched; a host path named like the branch does not confuse git",
    async () => {
      const file = path.join(fx.hostRepo, "registry.conf")
      writeFileSync(file, "registry=http://npm-cache:4873/\nretries=1\n")
      await git(fx.hostRepo, ["add", "registry.conf"])
      await git(fx.hostRepo, ["commit", "-q", "-m", "old address"])
      const lookalike = path.join(fx.hostRepo, "delegate", "mirror-old")
      try {
        const workspaces = fx.workspaces()
        const ws = await workspaces.open(fx.hostRepo, "mirror-old")
        mkdirSync(path.dirname(lookalike), { recursive: true })
        writeFileSync(lookalike, "untracked file named like the branch\n")
        await fx.boxCommit("mirror-old", { "registry.conf": "registry=http://npm-cache:4873/\nretries=2\n" }, "other line")
        const result = await workspaces.collect(ws)
        expect(result.mirrorAddressFiles).toEqual(["registry.conf"])
      } finally {
        rmSync(path.join(fx.hostRepo, "delegate"), { recursive: true, force: true })
        await git(fx.hostRepo, ["rm", "-q", "registry.conf"])
        await git(fx.hostRepo, ["commit", "-q", "-m", "drop old address"])
      }
    },
    T,
  )

  // #186: real git, with one host step swapped for a failure. A failed check is null with a reason,
  // never [] (that would read as clean).
  const failing = (match: string, failure: ExecResult) => fx.workspaces({ hostExec: async (argv, o) => (argv.includes(match) ? failure : runCommand(argv, undefined, o?.timeoutMs)) })
  for (const [name, match, failure, reason] of [
    ["git diff fails", "--name-only", { code: 128, stdout: "", stderr: "fatal: bad object\nmore" }, "git diff exited 128: fatal: bad object"],
    ["git diff times out", "--name-only", { code: TIMEOUT_CODE, stdout: "", stderr: "", timedOut: true }, "git diff timed out"],
    ["git grep exits 2", "grep", { code: 2, stdout: "", stderr: "fatal: corrupt" }, "git grep exited 2: fatal: corrupt"],
    ["git grep times out", "grep", { code: TIMEOUT_CODE, stdout: "", stderr: "", timedOut: true }, "git grep timed out"],
  ] as const) {
    const key = `mirror-fail-${name.replaceAll(" ", "-")}`
    test(
      `${name}: the check reports null and the reason`,
      async () => {
        const workspaces = failing(match, failure)
        const ws = await workspaces.open(fx.hostRepo, key)
        await fx.boxCommit(key, { "uv.lock": 'source = { registry = "http://pypi-cache:5000/index/" }\n' }, "lockfile")
        const result = await workspaces.collect(ws)
        expect(result.mirrorAddressFiles).toBeNull()
        expect(result.mirrorCheckError).toBe(reason)
        expect(result.commits).toBe(1)
      },
      T,
    )
  }

  test(
    "too many changed names for one command line: the whole tree is read and still intersected",
    async () => {
      const files: Record<string, string> = { "uv.lock": 'source = { registry = "http://pypi-cache:5000/index/" }\n' }
      for (let i = 0; i < 200; i++) files[`many/${"n".repeat(90)}-${i}.txt`] = `${i}\n`
      expect(Object.keys(files).join(" ").length).toBeGreaterThan(MAX_PATHSPEC_CHARS)
      const seen: (readonly string[])[] = []
      const watched = fx.workspaces({ hostExec: async (argv, o) => (argv.includes("grep") && seen.push(argv), runCommand(argv, undefined, o?.timeoutMs)) })
      const ws = await watched.open(fx.hostRepo, "mirror-many")
      await fx.boxCommit("mirror-many", files, "many files")
      const result = await watched.collect(ws)
      expect(result.mirrorAddressFiles).toEqual(["uv.lock"])
      expect(seen[0]?.at(-1)).toBe("--") // no pathspecs: the whole tree
    },
    T,
  )

  test(
    "a few changed names: only those files are read",
    async () => {
      const seen: (readonly string[])[] = []
      const workspaces = fx.workspaces({ hostExec: async (argv, o) => (argv.includes("grep") && seen.push(argv), runCommand(argv, undefined, o?.timeoutMs)) })
      const ws = await workspaces.open(fx.hostRepo, "mirror-few")
      await fx.boxCommit("mirror-few", { "uv.lock": 'source = { registry = "http://pypi-cache:5000/index/" }\n', "docs/notes.md": "plain\n" }, "few")
      expect((await workspaces.collect(ws)).mirrorAddressFiles).toEqual(["uv.lock"])
      const argv = seen[0] ?? []
      expect(argv).toContain("--literal-pathspecs")
      expect(argv.slice(argv.indexOf("--") + 1).sort()).toEqual(["docs/notes.md", "uv.lock"])
    },
    T,
  )

  // QA on #186: names Windows cannot write to disk but the box's Linux tree can hold. Built with
  // plumbing (raw bytes in, no checkout) so the test runs on Windows too.
  const commitRawName = async (key: string, name: Uint8Array, content: string) => {
    const run = async (args: string[], input?: Uint8Array) => {
      const p = Bun.spawn(["git", "-C", fx.boxClone(key), ...args], { stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe", env: fx.boxEnv })
      const [out, err, exit] = [await new Response(p.stdout).arrayBuffer(), await new Response(p.stderr).text(), await p.exited]
      if (exit !== 0) throw new Error(`git ${args.join(" ")}: ${err}`)
      return new Uint8Array(out)
    }
    const text = (b: Uint8Array) => new TextDecoder().decode(b).trim()
    const entry = (type: "blob" | "tree", sha: string, part: Uint8Array) => Buffer.concat([Buffer.from(`${type === "blob" ? "100644" : "040000"} ${type} ${sha}\t`), Buffer.from(part), Buffer.from([0])])
    // Split on "/" (0x2f) and build the trees bottom-up, so a part can be ".." or "C:".
    const parts: Uint8Array[] = []
    let start = 0
    for (let i = 0; i <= name.length; i++) {
      if (i < name.length && name[i] !== 0x2f) continue
      parts.push(name.slice(start, i))
      start = i + 1
    }
    let sha = text(await run(["hash-object", "-w", "--stdin"], new TextEncoder().encode(content)))
    let type: "blob" | "tree" = "blob"
    for (let i = parts.length - 1; i > 0; i--) {
      sha = text(await run(["mktree", "-z"], entry(type, sha, parts[i]!)))
      type = "tree"
    }
    const top = Buffer.concat([Buffer.from(await run(["ls-tree", "-z", "HEAD"])), entry(type, sha, parts[0]!)])
    const tree = text(await run(["mktree", "-z"], top))
    const commit = text(await run(["commit-tree", tree, "-p", "HEAD", "-m", `raw name ${key}`]))
    await run(["update-ref", "HEAD", commit])
  }
  // Names are built when the test runs: fx.hostRepo is set in beforeAll.
  for (const [label, key, name] of [
    ["a backslash", "mirror-raw-backslash", () => Buffer.from("back\\slash.lock")],
    ["bytes that are not UTF-8", "mirror-raw-utf8", () => Buffer.from([0x62, 0x61, 0x64, 0xe9, 0x2e, 0x6c, 0x6f, 0x63, 0x6b])],
    // Git for Windows reads this as a path inside the host repo and drops the prefix.
    ["the host repo's own path", "mirror-raw-hostpath", () => Buffer.from(`${posix(fx.hostRepo).replace(/^\//, "")}/evil.lock`)],
  ] as const) {
    test(
      `a changed name with ${label} is still searched`,
      async () => {
        const workspaces = fx.workspaces()
        const ws = await workspaces.open(fx.hostRepo, key)
        await commitRawName(key, name(), "registry=http://npm-cache:4873/\n")
        const result = await workspaces.collect(ws)
        expect(result.mirrorAddressFiles).toHaveLength(1)
      },
      T,
    )
  }

  // `.` and `..` parts never reach the check: collect's fetch runs git's object check, which refuses them.
  for (const [label, key, name] of [
    ["a .. part", "mirror-raw-dotdot", "dir/../evil.lock"],
    ["a . part", "mirror-raw-dot", "dir/./evil.lock"],
  ] as const) {
    test(
      `a branch with ${label} in a name is refused at fetch`,
      async () => {
        const workspaces = fx.workspaces()
        const ws = await workspaces.open(fx.hostRepo, key)
        await commitRawName(key, Buffer.from(name), "registry=http://npm-cache:4873/\n")
        expect(await code(workspaces.collect(ws))).toBe("policy_violation")
      },
      T,
    )
  }

  test("grepPathspecs: unsafe names and long lists read the whole tree", () => {
    expect(grepPathspecs(["a.lock", "sub/b-1_2@x+y.json"])).toEqual(["a.lock", "sub/b-1_2@x+y.json"])
    for (const unsafe of ["[i]", "a b", "C:/x.lock", "dir/../x", "dir/./x", "a//b", "/abs", "x/"]) expect(grepPathspecs(["a.lock", unsafe])).toEqual([])
    expect(grepPathspecs(["a.lock", "b\\c.lock"])).toEqual([])
    expect(grepPathspecs(["a.lock", "bad�.lock"])).toEqual([])
    // Counted twice plus 3: 3,000 names of 2 characters would be 9,000 raw but 21,000 counted.
    expect(grepPathspecs(Array.from({ length: 3000 }, (_, i) => String(i % 100).padStart(2, "0")))).toEqual([])
  })

  test(
    "#188: host git config that forces colour does not hide a file or a host-executable change",
    async () => {
      // As if the owner's global config set color.ui / color.grep / color.diff = always.
      const colour = ["-c", "color.ui=always", "-c", "color.grep=always", "-c", "color.diff=always"]
      const workspaces = fx.workspaces({ hostExec: async (argv, o) => runCommand(argv[0] === "git" ? ["git", ...colour, ...argv.slice(1)] : argv, undefined, o?.timeoutMs) })
      const ws = await workspaces.open(fx.hostRepo, "mirror-colour")
      await fx.boxCommit("mirror-colour", { "uv.lock": 'source = { registry = "http://pypi-cache:5000/index/" }\n', ".githooks/pre-commit": "echo hi\n" }, "colour")
      const result = await workspaces.collect(ws)
      expect(result.mirrorAddressFiles).toEqual(["uv.lock"])
      expect(result.hostExecutableChanges).toContain(".githooks/pre-commit")
    },
    T,
  )

  test(
    "a branch without the address lists nothing",
    async () => {
      const workspaces = fx.workspaces()
      const ws = await workspaces.open(fx.hostRepo, "mirror-clean")
      await fx.boxCommit("mirror-clean", { "package-lock.json": '{"resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz"}\n' }, "clean")
      expect((await workspaces.collect(ws)).mirrorAddressFiles).toEqual([])
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

describe("workspaces: only the current branch is bundled, and the host record (W3C-11 / W3C-01)", () => {
  test(
    "open bundles HEAD only: another branch's commits never reach the box; base is the host HEAD",
    async () => {
      await git(fx.hostRepo, ["checkout", "-q", "-b", "private-branch"])
      writeFileSync(path.join(fx.hostRepo, "secret.txt"), "not for the box\n")
      await git(fx.hostRepo, ["add", "secret.txt"])
      await git(fx.hostRepo, ["commit", "-q", "-m", "private"])
      const hidden = await git(fx.hostRepo, ["rev-parse", "HEAD"])
      await git(fx.hostRepo, ["checkout", "-q", "main"])
      try {
        const ws = await fx.workspaces().open(fx.hostRepo, "head-only")
        expect(ws.base).toBe(await git(fx.hostRepo, ["rev-parse", "HEAD"]))
        const refs = await fx.boxGit("head-only", ["for-each-ref", "--format=%(refname)"])
        expect(refs.split(/\r?\n/)).toEqual(["refs/heads/delegate/head-only"])
        expect(await fx.boxGit("head-only", ["cat-file", "-e", hidden]).then(() => "present", () => "absent")).toBe("absent")
      } finally {
        await git(fx.hostRepo, ["branch", "-q", "-D", "private-branch"])
      }
    },
    T,
  )

  test(
    "the host record: written by open, bound once to a session, listed, and removed by discard",
    async () => {
      const workspaces = fx.workspaces()
      const ws = await workspaces.open(fx.hostRepo, "record-key")
      const opened = await workspaces.sessionState("record-key")
      expect(opened).toMatchObject({ sessionKey: "record-key", base: ws.base })
      expect(opened?.sessionID).toBeUndefined()
      const binding = { sessionID: "ses_0123456789abcdefAB", profile: "readonly" as const, supervisor: "supervisor:ws-test", model: "synapse/auto" }
      expect(await workspaces.bindSession("record-key", binding)).toMatchObject(binding)
      expect(await workspaces.sessionState("record-key")).toMatchObject({ ...binding, hostRepo: opened?.hostRepo, base: ws.base })
      expect(await code(workspaces.bindSession("record-key", { ...binding, sessionID: "ses_ffffffffffffffffFF" }))).toBe("directory_busy")
      expect((await workspaces.listSessionStates()).some((s) => s.sessionKey === "record-key")).toBe(true)
      await workspaces.discard("record-key")
      expect(await workspaces.sessionState("record-key")).toBeUndefined()
      expect(fx.leftovers("record-key")).toEqual([])
    },
    T,
  )

  test("a record with a malformed session id or supervisor is not treated as bound", async () => {
    mkdirSync(path.join(fx.tmp, "state"), { recursive: true })
    const base = await git(fx.hostRepo, ["rev-parse", "HEAD"])
    writeFileSync(path.join(fx.tmp, "state", "forged-key.json"), JSON.stringify({ hostRepo: fx.hostRepo, base, sessionID: "ses_../../x", supervisor: "supervisor:ws-test" }))
    const state = await fx.workspaces().sessionState("forged-key")
    expect(state?.sessionID).toBeUndefined()
    expect(state?.supervisor).toBeUndefined()
  })
})

describe("workspaces: sync fetches the bundled ref by name (#143)", () => {
  test(
    "the box fetch names refs/delegate-sync/<nonce>, so a bundle without HEAD still lands",
    async () => {
      const nonce = "beefbeefbeefbeef"
      const workspaces = fx.workspaces({ nonce: () => nonce })
      const ws = await workspaces.open(fx.hostRepo, "sync-refspec")
      writeFileSync(path.join(fx.hostRepo, "host-note.txt"), "from the host\n")
      await git(fx.hostRepo, ["add", "host-note.txt"])
      await git(fx.hostRepo, ["commit", "-q", "-m", "host work"])
      const expectedSha = await git(fx.hostRepo, ["rev-parse", "HEAD"])
      const fetches: string[][] = []
      fx.boxOverride = (argv) => (argv.includes("fetch") ? (fetches.push([...argv]), undefined) : undefined)
      const result = await workspaces.sync(ws, "main")
      expect(result).toEqual({ synced: true, head: expectedSha, commitsSynced: 1 })
      expect(fetches).toHaveLength(1)
      expect(fetches[0]?.at(-1)).toBe("refs/delegate-sync/beefbeefbeefbeef")
      expect(await fx.boxGit("sync-refspec", ["rev-parse", "HEAD"])).toBe(expectedSha)
    },
    T,
  )
})
