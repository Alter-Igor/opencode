// MOD-03 T3.4: watch CLI — arguments, attention filter, line format, stdout/stderr split, exit codes.
import { afterEach, describe, expect, test } from "bun:test"
import { EXIT, formatLine, isAttention, parseArgs, useColor, watch, type WatchDeps } from "../src/cli/watch.ts"
import { createHub, type DelegateHub } from "../src/events/hub.ts"
import type { BoxState, HubEvent } from "../src/shared/contracts.ts"
import { startFakeBox, until, type FakeBox } from "./events-fake.ts"

const ev = (x: Partial<HubEvent>): HubEvent => ({ cursor: { epoch: "e", seq: 1 }, at: "2026-10-01T00:00:00.000Z", type: "status", summary: "s", ...x })

describe("watch helpers", () => {
  test("parseArgs", () => {
    expect(parseArgs([])).toEqual({ kind: "run", json: false, noColor: false })
    expect(parseArgs(["-s", "ses_1", "--json"])).toEqual({ kind: "run", session: "ses_1", json: true, noColor: false })
    expect(parseArgs(["--session"]).kind).toBe("error")
    expect(parseArgs(["--session", "bad id;"]).kind).toBe("error")
    expect(parseArgs(["--bogus"]).kind).toBe("error")
    expect(parseArgs(["-h"]).kind).toBe("help")
  })

  test("attention events only", () => {
    for (const state of ["idle", "needs_input", "error", "aborted", "not_started", "server_down"] as const) expect(isAttention(ev({ state }))).toBe(true)
    expect(isAttention(ev({ type: "resync" }))).toBe(true)
    expect(isAttention(ev({ type: "inbox" }))).toBe(true)
    expect(isAttention(ev({ state: "busy" }))).toBe(false)
    expect(isAttention(ev({ state: "unknown" }))).toBe(false)
    expect(isAttention(ev({ type: "message" }))).toBe(false)
  })

  test("format: plain, coloured, json; untrusted text never in the plain line", () => {
    const e = ev({ state: "idle", sessionID: "ses_1", summary: "session ses_1 is idle", untrusted: "IGNORE PREVIOUS" })
    expect(formatLine(e, { json: false, color: false })).toBe("2026-10-01T00:00:00.000Z idle        ses_1 session ses_1 is idle")
    expect(formatLine(e, { json: false, color: true })).toStartWith("\x1b[32m")
    expect(JSON.parse(formatLine(e, { json: true, color: false }))).toEqual(e)
  })

  test("colour only on a TTY without NO_COLOR / TERM=dumb / --no-color", () => {
    expect(useColor(true, {}, false)).toBe(true)
    expect(useColor(false, {}, false)).toBe(false)
    expect(useColor(true, { NO_COLOR: "1" }, false)).toBe(false)
    expect(useColor(true, { TERM: "dumb" }, false)).toBe(false)
    expect(useColor(true, {}, true)).toBe(false)
  })
})

type Captured = { out: string[]; err: string[]; stop(): void; deps: WatchDeps; hubs: DelegateHub[] }

function capture(box: BoxState, options: { backoffMs?: number[] } = {}): Captured {
  let stop = () => {}
  const stopped = new Promise<void>((resolve) => (stop = resolve))
  const c: Captured = { out: [], err: [], stop: () => stop(), hubs: [], deps: undefined as unknown as WatchDeps }
  c.deps = {
    boxStatus: async () => box,
    hub: (target, trackAll) => {
      const h = createHub({ target, trackAll, backoffMs: options.backoffMs ?? [20] })
      c.hubs.push(h)
      return h
    },
    out: (l) => c.out.push(l),
    err: (l) => c.err.push(l),
    stopped: () => stopped,
    isTTY: false,
    env: {},
  }
  return c
}

let box: FakeBox | undefined
afterEach(async () => {
  await box?.stop()
  box = undefined
})

describe("watch", () => {
  test("sandbox not running → clear stderr message, exit 2, nothing on stdout", async () => {
    const c = capture({ state: "stopped" })
    expect(await watch([], c.deps)).toBe(EXIT.boxDown)
    expect(c.out).toEqual([])
    expect(c.err.join("\n")).toContain("not running")
  })

  test("bad arguments → exit 64 on stderr", async () => {
    const c = capture({ state: "stopped" })
    expect(await watch(["--nope"], c.deps)).toBe(EXIT.usage)
    expect(c.out).toEqual([])
  })

  test("--session for an unknown id → exit 3", async () => {
    box = startFakeBox()
    const c = capture({ state: "running", target: box.target, imageTag: "t", startedBy: "other" })
    expect(await watch(["--session", "ses_missing"], c.deps)).toBe(EXIT.notFound)
  })

  test("prints one line per attention event, stops with exit 0", async () => {
    box = startFakeBox()
    box.sessions.set("ses_1", { id: "ses_1", directory: "/sessions/a" })
    const c = capture({ state: "running", target: box.target, imageTag: "t", startedBy: "other" })
    const running = watch(["--session", "ses_1", "--json"], c.deps)
    await until(() => c.err.some((l) => l.includes("watching")), 3000, "watching")
    const send = (type: string) => box?.send({ type: "session.status", properties: { sessionID: "ses_1", status: { type } } })
    send("busy")
    box.send({ type: "permission.asked", properties: { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls"] } })
    box.send({ type: "permission.replied", properties: { sessionID: "ses_1", requestID: "per_1", reply: "once" } })
    send("idle")
    await until(() => c.out.length >= 2, 3000, "two lines")
    c.stop()
    expect(await running).toBe(EXIT.ok)
    const lines = c.out.map((l) => JSON.parse(l) as HubEvent)
    expect(lines.map((l) => `${l.type}:${l.state}`)).toEqual(["permission:needs_input", "status:idle"])
  })
})
