// R5-01: stored MCP sign-ins for entries outside the chosen Keystone set are removed from the box.
// The in-box script is run here with the host's own runtime against a temp file (the bridge runs it
// with the box's node against /data/opencode/mcp-auth.json). Token values must never come out.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { AUTH_FILE, AUTH_SCRIPT, BOX_NODE, authArgs, parseAuthResult, readPruned, recordPruned } from "../src/supervisor/auth-store.ts"

const scratch = mkdtempSync(path.join(os.tmpdir(), "ocd-auth-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0

const SECRET_ACCESS = "access-SECRET-a1b2c3"
const SECRET_REFRESH = "refresh-SECRET-d4e5f6"
const entry = (url: string, clientId = "dcr-0000aaaa") => ({ tokens: { accessToken: SECRET_ACCESS, refreshToken: SECRET_REFRESH, expiresAt: 1 }, clientInfo: { clientId }, serverUrl: url })
const STORE = {
  "ks-rag-global": entry("https://identity.alterspective.com.au/mcp/c/rag-global"),
  "ks-github": entry("https://identity.alterspective.com.au/mcp/c/github"),
  "ks-delegate": entry("https://identity.alterspective.com.au/mcp/dynamic", "dcr-0226f1c0"),
  "ks-test-stale": { serverUrl: "https://identity.alterspective.com.au/mcp/c/test-stale" },
}

function home(store?: unknown) {
  const dir = path.join(scratch, `h${n++}`)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "mcp-auth.json")
  if (store !== undefined) writeFileSync(file, typeof store === "string" ? store : JSON.stringify(store), { mode: 0o600 })
  return { dir, file }
}

/** Run the in-box script with this runtime; HOME decides OpenCode's lock folder, as in the box. */
function run(dir: string, mode: "list" | "prune", file: string, keep: string[] = [], waitMs = 2_000) {
  const argv = authArgs(mode, keep, waitMs)
  expect(argv.slice(0, 3)).toEqual([BOX_NODE, "-e", AUTH_SCRIPT])
  expect(argv[4]).toBe(AUTH_FILE)
  const args = [...argv.slice(3, 4), file, ...argv.slice(5)]
  const out = Bun.spawnSync([process.execPath, "-e", AUTH_SCRIPT, ...args], { env: { ...process.env, HOME: dir, XDG_STATE_HOME: "" } })
  return { code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() }
}

describe("in-box auth store script (R5-01)", () => {
  test("prune keeps only the chosen ks-<id> entries, reports the others by name, and never prints a token", () => {
    const { dir, file } = home(STORE)
    const out = run(dir, "prune", file, ["ks-rag-global", "ks-github"])
    expect(out.code).toBe(0)
    expect(out.stdout).not.toContain("SECRET")
    const result = parseAuthResult(out.stdout)
    expect(result.names).toEqual(["ks-rag-global", "ks-github"])
    expect(result.removed).toEqual([
      { name: "ks-delegate", clientId: "dcr-0226f1c0", server: "/mcp/dynamic", hadRefresh: true },
      { name: "ks-test-stale", server: "/mcp/c/test-stale", hadRefresh: false },
    ])
    const after = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    expect(Object.keys(after)).toEqual(["ks-rag-global", "ks-github"])
    expect(after["ks-github"]).toEqual(STORE["ks-github"])
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600)
    // No temp file or lock left behind.
    expect(readdirNames(dir).filter((name) => name.includes("tmp"))).toEqual([])
    expect(existsSync(lockDir(dir, file))).toBe(false)
  })

  test("list gives names only; a missing file is an empty store; nothing to remove leaves the file alone", () => {
    const { dir, file } = home(STORE)
    const listed = run(dir, "list", file)
    expect(listed.stdout).not.toContain("SECRET")
    expect(parseAuthResult(listed.stdout)).toEqual({ names: Object.keys(STORE), unrecognised: 0, removed: [] })
    const empty = home()
    expect(parseAuthResult(run(empty.dir, "prune", empty.file, ["ks-github"]).stdout)).toEqual({ names: [], unrecognised: 0, removed: [] })
    expect(existsSync(empty.file)).toBe(false)
    const kept = home({ "ks-github": STORE["ks-github"] })
    const before = statSync(kept.file).mtimeMs
    expect(parseAuthResult(run(kept.dir, "prune", kept.file, ["ks-github"]).stdout).removed).toEqual([])
    expect(statSync(kept.file).mtimeMs).toBe(before)
  })

  test("a damaged store fails (non-zero) and is not touched", () => {
    const { dir, file } = home("[1,2")
    const out = run(dir, "prune", file, [])
    expect(out.code).not.toBe(0)
    expect(readFileSync(file, "utf8")).toBe("[1,2")
  })

  test("OpenCode's own lock on the store is respected: a held lock makes prune wait, then fail, untouched", () => {
    const { dir, file } = home(STORE)
    mkdirSync(lockDir(dir, file), { recursive: true })
    writeFileSync(path.join(lockDir(dir, file), "heartbeat"), "")
    const out = run(dir, "prune", file, [], 300)
    expect(out.code).not.toBe(0)
    expect(out.stderr).toContain("lock")
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")) as object)).toEqual(Object.keys(STORE))
  })
})

describe("host side", () => {
  test("box output is untrusted: odd names are counted, not echoed; a bad shape throws", () => {
    const odd = JSON.stringify({ names: ["ks-github", "x\u001b[31m", "a".repeat(300)], removed: [{ name: "<script>", hadRefresh: true, clientId: "bad id with spaces", server: "https://evil.example/x" }] })
    expect(parseAuthResult(odd)).toEqual({ names: ["ks-github"], unrecognised: 2, removed: [{ name: "(unrecognised name)", server: "other", hadRefresh: true }] })
    for (const bad of ["", "nope", "{}", '{"names":"x"}']) expect(() => parseAuthResult(bad)).toThrow()
  })

  test("removed entries are recorded in the bridge home (names only) for oc_doctor", () => {
    const dir = home().dir
    expect(readPruned(dir)).toEqual([])
    recordPruned(dir, [{ name: "ks-delegate", clientId: "dcr-0226f1c0", server: "/mcp/dynamic", hadRefresh: true }], "2026-10-01T00:00:00.000Z")
    recordPruned(dir, [], "2026-10-01T00:00:01.000Z")
    const text = readFileSync(path.join(dir, "auth-pruned.json"), "utf8")
    expect(text).not.toContain("SECRET")
    expect(readPruned(dir)).toEqual([{ name: "ks-delegate", clientId: "dcr-0226f1c0", server: "/mcp/dynamic", hadRefresh: true, at: "2026-10-01T00:00:00.000Z" }])
  })
})

const readdirNames = (dir: string) => readdirSync(dir)

/** OpenCode's lock for the store: <state>/opencode/locks/<sha1("mcp-auth:" + file)>.lock (core/src/util/effect-flock.ts). */
function lockDir(dir: string, file: string): string {
  return path.join(dir, ".local", "state", "opencode", "locks", `${createHash("sha1").update(`mcp-auth:${file}`).digest("hex")}.lock`)
}
