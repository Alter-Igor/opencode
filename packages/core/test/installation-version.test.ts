import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { InstallationVersion, sourceVersion } from "../src/installation/version"

const SHA = "0123456789abcdef0123456789abcdef01234567"

describe("sourceVersion", () => {
  let root: string

  const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), text)
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "version-"))
    await write("packages/core/package.json", JSON.stringify({ version: "9.8.7" }))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("reads a branch ref", async () => {
    await write(".git/HEAD", "ref: refs/heads/dev\n")
    await write(".git/refs/heads/dev", `${SHA}\n`)
    expect(sourceVersion(root)).toMatch(/^9\.8\.7-alt \[0123456789 \d{4}-\d{2}-\d{2} \d{2}:\d{2}\]$/)
  })

  test("reads a packed ref", async () => {
    await write(".git/HEAD", "ref: refs/heads/dev\n")
    await write(".git/packed-refs", `# pack-refs with: peeled\n${SHA} refs/heads/dev\n`)
    expect(sourceVersion(root)).toStartWith("9.8.7-alt [0123456789 ")
  })

  test("reads a detached head", async () => {
    await write(".git/HEAD", `${SHA}\n`)
    expect(sourceVersion(root)).toStartWith("9.8.7-alt [0123456789 ")
  })

  test("follows a worktree's .git file to the shared refs", async () => {
    await write(".git", "gitdir: main/.git/worktrees/wt\n")
    await write("main/.git/worktrees/wt/HEAD", "ref: refs/heads/feature\n")
    await write("main/.git/worktrees/wt/commondir", "../..\n")
    await write("main/.git/refs/heads/feature", `${SHA}\n`)
    expect(sourceVersion(root)).toStartWith("9.8.7-alt [0123456789 ")
  })

  test("falls back to the package version without git", async () => {
    expect(sourceVersion(root)).toBe("9.8.7-alt")
  })

  test("the running label matches this checkout's package version", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(import.meta.dir, "..", "package.json"), "utf8"))
    expect(InstallationVersion).toStartWith(`${pkg.version}-alt`)
  })
})
