import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { InstallationVersion, sourceVersion } from "../src/installation/version"

const SHA = "0123456789abcdef0123456789abcdef01234567"
const OLD = "fedcba9876543210fedcba9876543210fedcba98"
const LANDED = 1791031759

// A reflog line: old sha, new sha, who, unix time, zone, tab, message.
const reflog = (to: string, at = LANDED) =>
  `${OLD} ${to} Someone <someone@example.test> ${at} +1000\tmerge: Fast-forward\n`

const local = (seconds: number) => {
  const date = new Date(seconds * 1000)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

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

  test("reads a branch ref and the time its reflog says it landed", async () => {
    await write(".git/HEAD", "ref: refs/heads/dev\n")
    await write(".git/refs/heads/dev", `${SHA}\n`)
    await write(".git/logs/refs/heads/dev", reflog(OLD, 1) + reflog(SHA))
    expect(sourceVersion(root)).toBe(`9.8.7-alt [0123456789 ${local(LANDED)}]`)
  })

  test("reads a packed ref, and the packed-refs file time never changes the label", async () => {
    await write(".git/HEAD", "ref: refs/heads/dev\n")
    await write(".git/packed-refs", `# pack-refs with: peeled\n${SHA} refs/heads/dev\n`)
    await write(".git/logs/refs/heads/dev", reflog(SHA))
    const before = sourceVersion(root)
    await fs.utimes(path.join(root, ".git/packed-refs"), new Date(), new Date(Date.now() + 86_400_000))
    expect(sourceVersion(root)).toBe(before)
    expect(before).toBe(`9.8.7-alt [0123456789 ${local(LANDED)}]`)
  })

  test("reads a detached head from the HEAD reflog", async () => {
    await write(".git/HEAD", `${SHA}\n`)
    await write(".git/logs/HEAD", reflog(SHA))
    expect(sourceVersion(root)).toBe(`9.8.7-alt [0123456789 ${local(LANDED)}]`)
  })

  test("follows a worktree's .git file to the shared refs and reflog", async () => {
    await write(".git", "gitdir: main/.git/worktrees/wt\n")
    await write("main/.git/worktrees/wt/HEAD", "ref: refs/heads/feature\n")
    await write("main/.git/worktrees/wt/commondir", "../..\n")
    await write("main/.git/refs/heads/feature", `${SHA}\n`)
    await write("main/.git/logs/refs/heads/feature", reflog(SHA))
    expect(sourceVersion(root)).toBe(`9.8.7-alt [0123456789 ${local(LANDED)}]`)
  })

  test("leaves the time out when the reflog is missing or ends on another commit", async () => {
    await write(".git/HEAD", "ref: refs/heads/dev\n")
    await write(".git/refs/heads/dev", `${SHA}\n`)
    expect(sourceVersion(root)).toBe("9.8.7-alt [0123456789]")
    await write(".git/logs/refs/heads/dev", reflog(OLD))
    expect(sourceVersion(root)).toBe("9.8.7-alt [0123456789]")
  })

  test("falls back to the package version without git", async () => {
    expect(sourceVersion(root)).toBe("9.8.7-alt")
  })

  test("the running label matches this checkout's package version", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(import.meta.dir, "..", "package.json"), "utf8"))
    expect(InstallationVersion).toStartWith(`${pkg.version}-alt`)
  })
})
