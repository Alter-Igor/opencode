#!/usr/bin/env bun
// Fork-only (#93, KB playbook AIPB-008): the fast tier. Runs oxlint on the changed files and only the
// tests mapped to them, so an agent gets an answer in seconds instead of a 10+ minute full suite.
// `bun test --changed` is not used: plugin and core files reach most of the suite through imports.
//
// A changed file maps to tests in its package (the nearest folder with package.json and test/):
//   - a changed *.test.ts(x) file runs itself;
//   - src/<dir>/<name>.ts maps to test/<dir>/<name>*.test.ts, test/<dir>/<name>/**, the flat
//     layout test/<dir>-*.test.ts and test/<name>*.test.ts;
//   - plus every test file in the package that imports the changed module directly.
// The full suite still runs in CI on Linux (Tier 2); this is not a substitute for it.
//
// Usage: bun run test:fast [--base origin/dev] [--list] [--no-lint]
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import path from "path"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string, fallback: string) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

const root = git(["rev-parse", "--show-toplevel"]).trim()
const base = option("--base", "origin/dev")
const listOnly = flag("--list")

function git(argv: string[]): string {
  const run = Bun.spawnSync(["git", ...argv], { stdout: "pipe", stderr: "pipe" })
  if (run.exitCode !== 0) throw new Error(`git ${argv.join(" ")} failed: ${run.stderr.toString().trim()}`)
  return run.stdout.toString()
}

const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

/** Files changed against the merge base with `base`, plus uncommitted and untracked files. */
function changedFiles(): string[] {
  const mergeBase = git(["merge-base", base, "HEAD"]).trim()
  const files = new Set([
    ...lines(git(["diff", "--name-only", "--diff-filter=ACMR", mergeBase])),
    ...lines(git(["ls-files", "--others", "--exclude-standard"])),
  ])
  return [...files].filter((file) => existsSync(path.join(root, file)))
}

const CODE = /\.(ts|tsx|js|mjs|cjs)$/
const TEST = /\.test\.(ts|tsx)$/

/** The nearest folder above `file` holding package.json and a test/ folder. */
function packageOf(file: string): string | undefined {
  let dir = path.dirname(file)
  while (dir && dir !== ".") {
    const abs = path.join(root, dir)
    if (existsSync(path.join(abs, "package.json")) && existsSync(path.join(abs, "test"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "fixtures" || entry === "fixture") continue
    const abs = path.join(dir, entry)
    if (statSync(abs).isDirectory()) out.push(...walk(abs))
    else if (TEST.test(entry)) out.push(abs)
  }
  return out
}

const testsByPackage = new Map<string, string[]>()
function testsOf(pkg: string): string[] {
  let tests = testsByPackage.get(pkg)
  if (!tests) {
    tests = walk(path.join(root, pkg, "test")).map((abs) => path.relative(path.join(root, pkg), abs).split(path.sep).join("/"))
    testsByPackage.set(pkg, tests)
  }
  return tests
}

/** Test files (relative to the package) mapped to one changed file (relative to the package). */
function mapToTests(pkg: string, rel: string): string[] {
  if (TEST.test(rel)) return [rel]
  if (!rel.startsWith("src/") || !CODE.test(rel)) return []
  const inner = rel.slice("src/".length).replace(CODE, "")
  const dir = path.posix.dirname(inner)
  const name = path.posix.basename(inner)
  const first = dir === "." ? "" : dir.split("/")[0]
  const module = inner.endsWith("/index") ? inner.slice(0, -"/index".length) : inner
  return testsOf(pkg).filter((test) => {
    const testDir = path.posix.dirname(test.slice("test/".length))
    const testName = path.posix.basename(test)
    if (testDir === dir && testName.startsWith(name)) return true
    if (test.startsWith(`test/${inner}/`)) return true
    if (testDir === "." && first && testName.startsWith(`${first}-`)) return true
    if (testDir === "." && testName.startsWith(name)) return true
    // A direct import of the changed module, with or without its extension.
    const source = readFileSync(path.join(root, pkg, test), "utf8")
    return ["", ".ts", ".tsx"].some((ext) => [`"`, `'`].some((quote) => source.includes(`src/${module}${ext}${quote}`)))
  })
}

const changed = changedFiles()
const plan = new Map<string, Set<string>>()
for (const file of changed) {
  const pkg = packageOf(file)
  if (!pkg) continue
  const rel = path.posix.relative(pkg, file)
  for (const test of mapToTests(pkg, rel)) {
    if (!plan.has(pkg)) plan.set(pkg, new Set())
    plan.get(pkg)!.add(test)
  }
}
const lintable = changed.filter((file) => CODE.test(file))

console.log(`test:fast against ${base}: ${changed.length} changed file(s), ${lintable.length} to lint`)
for (const [pkg, tests] of plan) console.log(`  ${pkg}: ${tests.size} test file(s)\n    ${[...tests].sort().join("\n    ")}`)
if (plan.size === 0) console.log("  no mapped tests (the Linux full suite in CI still covers this change)")
if (listOnly) process.exit(0)

let failed = false
if (!flag("--no-lint") && lintable.length > 0) {
  const lint = Bun.spawnSync(["bun", "x", "oxlint", ...lintable], { cwd: root, stdout: "inherit", stderr: "inherit" })
  if (lint.exitCode !== 0) failed = true
}
for (const [pkg, tests] of plan) {
  // A package outside the workspaces (alterspective/delegate-mcp) has its own lockfile and install.
  const pkgDir = path.join(root, pkg)
  if (existsSync(path.join(pkgDir, "bun.lock")) && !existsSync(path.join(pkgDir, "node_modules"))) {
    const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: pkgDir, stdout: "inherit", stderr: "inherit" })
    if (install.exitCode !== 0) failed = true
  }
  const run = Bun.spawnSync(["bun", "test", "--timeout", "30000", ...[...tests].sort().map((test) => `./${test}`)], {
    cwd: path.join(root, pkg),
    stdout: "inherit",
    stderr: "inherit",
  })
  if (run.exitCode !== 0) failed = true
}
process.exit(failed ? 1 : 0)
