// MOD-04 wiring: bridge name, version string, the single-flight box manager and CLI parsing.
import { describe, expect, test } from "bun:test"
import { formatVersion, parseCli } from "../src/cli.ts"
import { bridgeName, createBoxManager, readVersion, shutdownSignal } from "../src/runtime.ts"
import type { ApiTarget } from "../src/shared/opencode-api.ts"
import { silentLogger } from "../src/shared/log.ts"
import { FakeApi, FakeHub, record } from "./tools-core-fixture.ts"
import { EventEmitter } from "node:events"
import { version } from "../package.json"

describe("bridge name and version", () => {
  test("OPENCODE_DELEGATE_NAME is validated; default is claude-<6 hex>", () => {
    expect(bridgeName({ OPENCODE_DELEGATE_NAME: "codex-1" })).toBe("codex-1")
    expect(bridgeName({})).toMatch(/^claude-[0-9a-f]{6}$/)
    expect(() => bridgeName({ OPENCODE_DELEGATE_NAME: "Bad Name" })).toThrow()
    expect(() => bridgeName({ OPENCODE_DELEGATE_NAME: "x".repeat(41) })).toThrow()
  })

  test("version is <package>-dev+<sha>, with .dirty when the package has changes", async () => {
    const clean = await readVersion(async (argv) => ({ code: 0, stdout: argv.includes("rev-parse") ? "abc1234def\n" : "", stderr: "" }), {})
    expect(clean).toMatchObject({ version: `${version}-dev+abc1234def`, sha: "abc1234def", dirty: false, built: null })
    const dirty = await readVersion(async (argv) => ({ code: 0, stdout: argv.includes("rev-parse") ? "abc1234\n" : " M src/x.ts\n", stderr: "" }), { APP_BUILD_DATE: "2026-10-01T00:00:00Z" })
    expect(dirty.version).toBe(`${version}-dev+abc1234.dirty`)
    expect(JSON.parse(formatVersion(dirty, true))).toMatchObject({ version: `${version}-dev+abc1234.dirty`, built: "2026-10-01T00:00:00Z" })
    expect(formatVersion(dirty, false)).toBe(`opencode-delegate ${version}-dev+abc1234.dirty`)
  })
})

describe("box manager", () => {
  function manager(targets: ApiTarget[]) {
    const order: string[] = []
    const hubs: FakeHub[] = []
    let ensures = 0
    let releases = 0
    let clock = 0
    const forced: boolean[] = []
    const sessions = new Map([["ses_0123456789abcdefAB", record()]])
    const next = () => targets[Math.min(ensures++, targets.length - 1)] as ApiTarget
    const m = createBoxManager({
      supervisor: {
        ensure: async () => next(),
        // `releases` counts replaces: the old box is let go and a new one started.
        replace: async (options) => (forced.push(options.force), releases++, { target: next(), interrupted: options.force ? 1 : 0, keystone: [] }),
      },
      sessions,
      log: silentLogger,
      api: () => new FakeApi(order),
      hub: () => {
        const hub = new FakeHub(order)
        hubs.push(hub)
        return hub
      },
      now: () => clock,
      revalidateMs: 1000,
    })
    return { m, hubs, forced, counts: () => ({ ensures, releases }), tick: (ms: number) => (clock += ms) }
  }
  const A = { baseUrl: "http://127.0.0.1:1", password: "a" }
  const B = { baseUrl: "http://127.0.0.1:2", password: "b" }

  test("concurrent box() calls share one ensure and one hub; sessions are tracked on it", async () => {
    const t = manager([A])
    const [x, y] = await Promise.all([t.m.box(), t.m.box()])
    expect(x).toBe(y)
    expect(t.counts().ensures).toBe(1)
    expect(t.hubs).toHaveLength(1)
    expect(t.hubs[0]?.tracked).toEqual([["ses_0123456789abcdefAB", "/sessions/s-0000000001"]])
    expect(t.m.peek()).toBe(x)
  })

  test("re-ensures after the revalidate window; the same target keeps the hub", async () => {
    const t = manager([A, A])
    const first = await t.m.box()
    await t.m.box()
    expect(t.counts().ensures).toBe(1)
    t.tick(1500)
    const again = await t.m.box()
    expect(t.counts().ensures).toBe(2)
    expect(again).toBe(first)
  })

  test("restart replaces the box, and a new target gets a new hub and notifies listeners", async () => {
    const t = manager([A, B])
    const seen: string[] = []
    t.m.onBox((box) => seen.push(box.target.baseUrl))
    await t.m.box()
    const next = await t.m.restart()
    expect(t.counts()).toEqual({ ensures: 2, releases: 1 })
    expect(next.target).toBe(B)
    expect(next.interrupted).toBe(0)
    expect(t.forced).toEqual([false])
    expect(t.hubs[0]?.stopped).toBe(1)
    expect(seen).toEqual([A.baseUrl, B.baseUrl])
  })

  test("restart with force passes it on; a box() during the restart shares it instead of ensuring", async () => {
    const t = manager([A, B])
    await t.m.box()
    const restarting = t.m.restart({ force: true })
    await Promise.resolve()
    const during = t.m.box()
    const [restarted, joined] = await Promise.all([restarting, during])
    expect(restarted.interrupted).toBe(1)
    expect(t.forced).toEqual([true])
    expect(joined.target).toBe(B)
    expect(t.counts().ensures).toBe(2)
  })

  test("R3-09: a new hub whose start() throws never leaves the stopped old hub in use", async () => {
    const order: string[] = []
    const hubs: FakeHub[] = []
    let clock = 0
    const targets = [A, B, B]
    const m = createBoxManager({
      supervisor: { ensure: async () => targets.shift() ?? B, replace: async () => ({ target: B, interrupted: 0, keystone: [] }) },
      sessions: new Map(),
      log: silentLogger,
      api: () => new FakeApi(order),
      hub: () => {
        const hub = new FakeHub(order)
        // The second hub (the first one on B) fails to start.
        if (hubs.length === 1) hub.start = async () => Promise.reject(new Error("stream refused"))
        hubs.push(hub)
        return hub
      },
      now: () => clock,
      revalidateMs: 1000,
    })
    const first = await m.box()
    clock += 1500
    await expect(m.box()).rejects.toThrow("stream refused")
    expect(m.peek()).toBeUndefined()
    expect(hubs[0]?.stopped).toBe(1)
    expect(hubs[1]?.stopped).toBe(1)
    const next = await m.box()
    expect(next).not.toBe(first)
    expect(next.hub).toBe(hubs[2] as FakeHub)
    expect(m.peek()).toBe(next)
  })

  test("a failed ensure is not cached", async () => {
    let calls = 0
    const m = createBoxManager({
      supervisor: { ensure: async () => (calls++ === 0 ? Promise.reject(new Error("down")) : A), replace: async () => ({ target: A, interrupted: 0, keystone: [] }) },
      sessions: new Map(),
      log: silentLogger,
      api: () => new FakeApi([]),
      hub: () => new FakeHub([]),
    })
    await expect(m.box()).rejects.toThrow("down")
    await expect(m.box()).resolves.toMatchObject({ target: A })
  })
})

describe("CLI", () => {
  test("parses commands and flags", () => {
    expect(parseCli([])).toEqual({ kind: "mcp", channels: false })
    expect(parseCli(["mcp", "--channels"])).toEqual({ kind: "mcp", channels: true })
    expect(parseCli(["--channels"])).toEqual({ kind: "mcp", channels: true })
    expect(parseCli(["--version", "--json"])).toEqual({ kind: "version", json: true })
    expect(parseCli(["doctor"])).toEqual({ kind: "doctor" })
    expect(parseCli(["watch", "--json", "-s", "ses_x"])).toEqual({ kind: "watch", args: ["--json", "-s", "ses_x"] })
    expect(parseCli(["-h"])).toEqual({ kind: "help" })
    expect(parseCli(["help"])).toEqual({ kind: "help" })
    expect(parseCli(["doctor", "--help"])).toEqual({ kind: "help" })
    expect(parseCli(["frobnicate"]).kind).toBe("error")
    expect(parseCli(["mcp", "--bogus"]).kind).toBe("error")
  })

  test("shutdownSignal resolves on stdin end or a signal", async () => {
    const proc = Object.assign(new EventEmitter(), { stdin: new EventEmitter() })
    const pending = shutdownSignal(proc as never)
    proc.stdin.emit("end")
    expect(await pending).toBe("stdin ended")
    const proc2 = Object.assign(new EventEmitter(), { stdin: new EventEmitter() })
    const pending2 = shutdownSignal(proc2 as never)
    proc2.emit("SIGTERM")
    expect(await pending2).toBe("SIGTERM")
  })
})
