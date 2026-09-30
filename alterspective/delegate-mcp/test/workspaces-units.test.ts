// Pure workspace helpers: host-executable detection (A-15, C-3), hand-off helpers (C-4), exec deadline (A-14).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  isHostExecutableMode,
  isHostExecutablePath,
  parseRawDiff,
  parseSubst,
  runCommand,
  scriptsChanged,
  TIMEOUT_CODE,
  type RawEntry,
} from "../src/supervisor/workspaces.ts"
import { ensureRealDir, removeEntry } from "../src/supervisor/workspaces-handoff.ts"
import { DelegateError } from "../src/shared/errors.ts"

let tmp = ""
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "ocd-wsu-"))
})
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe("isHostExecutablePath", () => {
  const flagged: Array<[string, string[]]> = [
    ["git files and hook folders", [".gitmodules", ".gitattributes", ".github/workflows/ci.yml", "a/.githooks/y", ".husky/x"]],
    ["direnv / pre-commit / MCP / bun / npm / yarn configs", [".envrc", "pkg/.envrc", ".pre-commit-config.yaml", ".mcp.json", "bunfig.toml", ".npmrc", ".yarnrc", ".yarnrc.yml"]],
    ["python build files", ["setup.py", "lib/pyproject.toml"]],
    ["agent instruction files", ["AGENTS.md", "CLAUDE.md", "docs/GEMINI.md", "claude.md"]],
    ["make files", ["Makefile", "makefile", "x/GNUmakefile"]],
    ["scripts by extension", ["a.bat", "b.CMD", "c.ps1", "d.sh"]],
    ["editor / agent / container folders", [".claude/settings.json", "a/.vscode/tasks.json", ".devcontainer/devcontainer.json", ".idea/runConfigurations/app.xml"]],
  ]
  for (const [label, paths] of flagged) {
    test(`flags ${label}`, () => {
      for (const p of paths) expect({ p, flagged: isHostExecutablePath(p) }).toEqual({ p, flagged: true })
    })
  }

  test("leaves ordinary files alone", () => {
    for (const p of ["README.md", "src/index.ts", "husky.md", "shell.txt", "package.json", ".idea/workspace.xml", "docs/agents.txt", "claude/notes.md", "mcp.json", "setup.cfg"]) {
      expect({ p, flagged: isHostExecutablePath(p) }).toEqual({ p, flagged: false })
    }
  })
})

describe("modes and raw diff", () => {
  const entry = (srcMode: string, dstMode: string): RawEntry => ({ srcMode, dstMode, status: "M", path: "x" })

  test("symlinks, submodules and executable files are flagged; plain files are not", () => {
    expect(isHostExecutableMode(entry("000000", "120000"))).toBe(true)
    expect(isHostExecutableMode(entry("120000", "100644"))).toBe(true)
    expect(isHostExecutableMode(entry("000000", "160000"))).toBe(true)
    expect(isHostExecutableMode(entry("100644", "100755"))).toBe(true)
    expect(isHostExecutableMode(entry("100755", "100755"))).toBe(true)
    expect(isHostExecutableMode(entry("100644", "100644"))).toBe(false)
    expect(isHostExecutableMode(entry("100755", "000000"))).toBe(false)
  })

  test("parseRawDiff reads -z output, including odd file names", () => {
    const sha = "a".repeat(40)
    const out = `:100644 100755 ${sha} ${sha} M\u0000tools/build\u0000:000000 120000 ${"0".repeat(40)} ${sha} A\u0000dir with space/link\u0000`
    expect(parseRawDiff(out)).toEqual([
      { srcMode: "100644", dstMode: "100755", status: "M", path: "tools/build" },
      { srcMode: "000000", dstMode: "120000", status: "A", path: "dir with space/link" },
    ])
    expect(parseRawDiff("")).toEqual([])
  })

  test("parseRawDiff fails closed on anything unexpected", () => {
    expect(() => parseRawDiff("garbage\u0000x\u0000")).toThrow(DelegateError)
    expect(() => parseRawDiff(`:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\u0000`)).toThrow(DelegateError)
  })

  test("scriptsChanged fails closed on unparseable package.json", () => {
    expect(scriptsChanged('{"scripts":{"a":"b"}}', '{"scripts":{"a":"b"},"version":"2"}')).toBe(false)
    expect(scriptsChanged('{"scripts":{"a":"b"}}', '{"scripts":{"a":"c"}}')).toBe(true)
    expect(scriptsChanged(undefined, '{"name":"x"}')).toBe(false)
    expect(scriptsChanged(undefined, '{"scripts":{}}')).toBe(true)
    expect(scriptsChanged("{bad", "{bad")).toBe(true)
  })
})

describe("hand-off helpers", () => {
  test("ensureRealDir creates a missing folder and refuses a file in its place", () => {
    const dir = path.join(tmp, "made", "in")
    ensureRealDir(dir)
    ensureRealDir(dir)
    const file = path.join(tmp, "a-file")
    writeFileSync(file, "x")
    expect(() => ensureRealDir(file)).toThrow(DelegateError)
  })

  test("removeEntry removes a file, ignores a missing path, refuses a real folder", () => {
    const file = path.join(tmp, "stale.bundle")
    writeFileSync(file, "x")
    removeEntry(file)
    removeEntry(file)
    const dir = path.join(tmp, "a-dir")
    mkdirSync(dir)
    expect(() => removeEntry(dir)).toThrow(DelegateError)
  })
})

describe("exec and helpers", () => {
  test("runCommand kills a command at its deadline and says so", async () => {
    const started = Date.now()
    const result = await runCommand([process.execPath, "-e", "setTimeout(() => {}, 20000)"], process.env, 300)
    expect(result.timedOut).toBe(true)
    expect(result.code).toBe(TIMEOUT_CODE)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test("runCommand without a deadline reports the exit code", async () => {
    const result = await runCommand([process.execPath, "-e", "process.exit(3)"], process.env)
    expect(result).toMatchObject({ code: 3 })
    expect(result.timedOut).toBeUndefined()
  })

  test("parseSubst reads `subst` output", () => {
    expect(parseSubst("T:\\: => X:\\some-dir\r\nW:\\: => C:\\GitHub\\x\r\n")).toEqual({ "T:": "X:\\some-dir", "W:": "C:\\GitHub\\x" })
  })
})
