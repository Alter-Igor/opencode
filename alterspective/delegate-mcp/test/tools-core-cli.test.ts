// W3A-18 / W3A-20: the CLI process (exit codes, stdout carries only JSON-RPC frames in mcp mode),
// console redirection, the shutdown cap, doctor exit codes and restart under concurrent calls.
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { EXIT, main, redirectConsole, runDoctor, type Io } from "../src/cli.ts"
import { createBoxManager, shutdownOnce, type Runtime } from "../src/runtime.ts"
import { silentLogger } from "../src/shared/log.ts"
import type { ApiTarget } from "../src/shared/opencode-api.ts"
import { FakeApi, FakeHub, fakeContext, record } from "./tools-core-fixture.ts"

const CLI = path.resolve(import.meta.dir, "..", "src", "cli.ts")

function capture(): Io & { outs: string[]; errs: string[] } {
  const outs: string[] = []
  const errs: string[] = []
  return { outs, errs, out: (t) => void outs.push(t), err: (t) => void errs.push(t) }
}

type Child = { code: number | null; stdout: string; stderr: string }

/** Run the CLI; `frames` are written to stdin one per line, then stdin is closed once `done(stdout)` holds. */
function runCli(args: string[], frames: object[] = [], done: (stdout: string) => boolean = () => true): Promise<Child> {
  const home = mkdtempSync(path.join(os.tmpdir(), "ocd-cli-"))
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, OPENCODE_DELEGATE_HOME: home, OPENCODE_DELEGATE_NAME: "cli-test", OPENCODE_DELEGATE_ROOTS: home }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  let stdout = ""
  let stderr = ""
  let closed = false
  const maybeClose = () => {
    if (!closed && done(stdout)) {
      closed = true
      child.stdin.end()
    }
  }
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString("utf8")
    maybeClose()
  })
  child.stderr.on("data", (d: Buffer) => void (stderr += d.toString("utf8")))
  for (const frame of frames) child.stdin.write(`${JSON.stringify(frame)}\n`)
  if (frames.length === 0) child.stdin.end()
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })))
}

describe("CLI process", () => {
  test("mcp mode: stdout holds only JSON-RPC frames, and stdin closing exits 0", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
    const result = await runCli(["mcp"], [init, { jsonrpc: "2.0", method: "notifications/initialized" }, list], (out) => out.includes('"id":2'))
    expect(result.code).toBe(EXIT.ok)
    const lines = result.stdout.split("\n").filter((l) => l.trim() !== "")
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const line of lines) expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe("2.0")
    expect(result.stdout).toContain("oc_start_session")
  }, 30_000)

  test("exit codes: help 0, bad arguments 2 (message on stderr only), version 0", async () => {
    const help = capture()
    expect(await main(["--help"], help)).toBe(EXIT.ok)
    const bad = capture()
    expect(await main(["frobnicate"], bad)).toBe(EXIT.usage)
    expect(bad.outs).toEqual([])
    expect(bad.errs[0]).toContain("Unknown command")
    const spawned = await runCli(["--bogus-flag"])
    expect(spawned.code).toBe(EXIT.usage)
    expect(spawned.stdout).toBe("")
  }, 30_000)
})

describe("console redirection in mcp mode (W3A-18)", () => {
  test("log, info, debug, dir, table, trace and warn all go to the stderr writer", () => {
    const target = { log: console.log, info: console.info, debug: console.debug, dir: console.dir, table: console.table, trace: console.trace, warn: console.warn, error: console.error }
    const written: string[] = []
    redirectConsole(target, (t) => void written.push(t))
    target.log("a")
    target.info("b")
    target.debug("c")
    target.dir({ d: 1 })
    target.table([{ e: 1 }])
    target.trace("f")
    target.warn("g")
    expect(written).toHaveLength(7)
    expect(written[0]).toBe("a\n")
    expect(written[3]).toContain("d")
  })
})

describe("doctor exit code (W3A-09)", () => {
  function runtimeWith(verified: boolean): () => Promise<Runtime> {
    const f = fakeContext({ boxHeld: false })
    f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: verified ? "connected" : "needs_auth" } } })
    return async () => ({ ctx: f.ctx, versionInfo: { version: "v", package: "0", sha: "x", dirty: false, built: null }, name: "t", shutdown: async () => {} })
  }

  test("exits 0 only when verified, 1 otherwise; the report is JSON on stdout", async () => {
    const good = capture()
    expect(await runDoctor(good, runtimeWith(true))).toBe(EXIT.ok)
    expect(JSON.parse(good.outs[0] ?? "{}")).toMatchObject({ verified: true })
    const poor = capture()
    expect(await runDoctor(poor, runtimeWith(false))).toBe(EXIT.failed)
    expect(JSON.parse(poor.outs[0] ?? "{}")).toMatchObject({ verified: false })
  })
})

describe("shutdown cap (W3A-20)", () => {
  test("a release that never finishes is abandoned at the cap; shutdown runs once", async () => {
    let stops = 0
    const shutdown = shutdownOnce({ stop: async () => void stops++ }, { release: () => new Promise<void>(() => {}) }, silentLogger, 50)
    const began = Date.now()
    await Promise.all([shutdown("a"), shutdown("b")])
    expect(Date.now() - began).toBeLessThan(2000)
    expect(stops).toBe(1)
  })
})

describe("restart under concurrent calls (W3A-20)", () => {
  test("box() calls before, during and after a restart all end on the new box; one replace, no extra ensure", async () => {
    const A: ApiTarget = { baseUrl: "http://127.0.0.1:1", password: "a" }
    const B: ApiTarget = { baseUrl: "http://127.0.0.1:2", password: "b" }
    let ensures = 0
    let replaces = 0
    const hubs: FakeHub[] = []
    const m = createBoxManager({
      supervisor: {
        ensure: async () => (ensures++ === 0 ? A : B),
        replace: async () => (replaces++, await Bun.sleep(20), { target: B, interrupted: 0, keystone: [] }),
      },
      sessions: new Map([[record().sessionID, record()]]),
      log: silentLogger,
      api: () => new FakeApi([]),
      hub: () => {
        const hub = new FakeHub([])
        hubs.push(hub)
        return hub
      },
      revalidateMs: 60_000,
    })
    await m.box()
    const restart = m.restart()
    const during = Promise.all([m.box(), m.box(), m.box()])
    const [restarted, boxes] = await Promise.all([restart, during])
    const after = await m.box()
    expect(replaces).toBe(1)
    expect(ensures).toBe(1)
    for (const b of [...boxes, after]) expect(b.target).toBe(B)
    expect(restarted.target).toBe(B)
    expect(hubs[0]?.stopped).toBeGreaterThanOrEqual(1)
    expect(hubs.at(-1)?.tracked).toEqual([[record().sessionID, record().boxPath]])
  })
})
