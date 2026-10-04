import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { checkBundleFile, checkTree, sha256File } from "../supervisor/bundle"

// #108 (fork #57 T5): a real repository, bundled, then checked the way the supervisor does.
let dir: string
let bundle: string
let tree: string

const git = (cwd: string, ...args: string[]) =>
  $`git -C ${cwd} -c user.name=test -c user.email=test@example.test ${args}`.quiet()

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sbxw-bundle-"))
  const repo = path.join(dir, "repo")
  await $`git init --quiet ${repo}`.quiet()
  await writeFile(path.join(repo, "math.js"), "export const add = (a, b) => a + b\n")
  await git(repo, "add", "-A")
  await git(repo, "commit", "--quiet", "-m", "base")
  bundle = path.join(dir, "repo.bundle")
  await git(repo, "bundle", "create", bundle, "HEAD")
  tree = (await git(repo, "rev-parse", "HEAD^{tree}").text()).trim()
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("checkBundleFile (#108)", () => {
  test("the matching SHA-256 passes, in any case", async () => {
    const sha = await sha256File(bundle)
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
    expect(await checkBundleFile(bundle, sha)).toEqual({ ok: true })
    expect(await checkBundleFile(bundle, sha.toUpperCase())).toEqual({ ok: true })
  })

  test("a tampered bundle is refused", async () => {
    const sha = await sha256File(bundle)
    const tampered = path.join(dir, "tampered.bundle")
    const bytes = await readFile(bundle)
    bytes[bytes.length - 1] ^= 0xff
    await writeFile(tampered, bytes)
    const check = await checkBundleFile(tampered, sha)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain("bundle SHA-256 mismatch")
  })

  test("a malformed expected value is refused without reading the file", async () => {
    expect(await checkBundleFile(bundle, "abc")).toEqual({ ok: false, reason: "repo.sha256 is not a 64-character hex SHA-256" })
  })

  test("a missing bundle file is refused", async () => {
    expect(await checkBundleFile(path.join(dir, "missing.bundle"), "0".repeat(64))).toEqual({
      ok: false,
      reason: "the bundle file cannot be read",
    })
  })
})

describe("checkTree (#108)", () => {
  test("a clone of the bundle has the expected tree", async () => {
    const clone = path.join(dir, "clone-ok")
    await $`git clone --quiet ${bundle} ${clone}`.quiet()
    expect(await checkTree(clone, tree)).toEqual({ ok: true })
  })

  test("a different tree is refused", async () => {
    const clone = path.join(dir, "clone-other")
    await $`git clone --quiet ${bundle} ${clone}`.quiet()
    await writeFile(path.join(clone, "math.js"), "export const add = () => 0\n")
    await git(clone, "commit", "--quiet", "-am", "changed")
    const check = await checkTree(clone, tree)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain("tree mismatch")
  })

  test("a malformed expected tree is refused", async () => {
    expect(await checkTree(dir, "not-a-sha")).toEqual({ ok: false, reason: "repo.treeSha is not a git object id" })
  })

  test("an empty repository is refused", async () => {
    const empty = path.join(dir, "empty")
    await $`git init --quiet ${empty}`.quiet()
    expect(await checkTree(empty, tree)).toEqual({ ok: false, reason: "the cloned repository has no commit to check" })
  })
})
