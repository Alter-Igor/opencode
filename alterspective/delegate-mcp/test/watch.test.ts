// MOD-03 T3.4: watch CLI — arguments, attention filter, line format, stdout/stderr split, exit codes.
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, test } from "bun:test"
import { EXIT, HELP, clean, formatLine, isAttention, parseArgs, parseSessionList, stopSignal, useColor, watch, type SignalSource, type WatchDeps } from "../src/cli/watch.ts"
import { createHub, type DelegateHub } from "../src/events/hub.ts"
import type { BoxState, HubEvent } from "../src/shared/contracts.ts"
import { DelegateError } from "../src/shared/errors.ts"
import type { OpencodeApi } from "../src/shared/opencode-api.ts"
import { fakeApi, startFakeBox, until, type FakeBox } from "./events-fake.ts"

const ev = (x: Partial<HubEvent>): HubEvent => ({ cursor: { epoch: "e", seq: 1 }, at: "2026-10-01T00:00:00.000Z", type: "status", summary: "s", ...x })
const SES = "ses_watch00000001"
const SES2 = "ses_watch00000002"
type SnapshotRow = { sessionID: string; directory: string; state: string; since: string; observedAt: string; pending: string[] }

describe("watch helpers", () => {
  test("parseArgs: --session takes only an OpenCode session id (W2C-04)", () => {
    expect(parseArgs([])).toEqual({ kind: "run", once: false, json: false, noColor: false })
    expect(parseArgs(["-s", SES, "--json"])).toEqual({ kind: "run", session: SES, once: false, json: true, noColor: false })
    expect(parseArgs(["--once"])).toEqual({ kind: "run", once: true, json: false, noColor: false })
    expect(parseArgs(["--session"]).kind).toBe("error")
    expect(parseArgs(["--session", "bad id;"]).kind).toBe("error")
    expect(parseArgs(["--session", "ses_short"]).kind).toBe("error")
    expect(parseArgs(["--session", "abc_0123456789"]).kind).toBe("error")
    expect(parseArgs(["--bogus"]).kind).toBe("error")
    expect(parseArgs(["-h"]).kind).toBe("help")
  })

  test("parseSessionList: rows without a valid id or box directory are dropped; a non-array throws", () => {
    expect(parseSessionList([{ id: SES, directory: "/sessions/a" }, { id: "bad", directory: "/sessions/a" }, { id: "ses_other000001", directory: "/etc/passwd" }, { id: "ses_second00001", directory: "/sessions/b" }]))
      .toEqual([{ id: SES, directory: "/sessions/a" }, { id: "ses_second00001", directory: "/sessions/b" }])
    expect(() => parseSessionList({})).toThrow()
    expect(() => parseSessionList(undefined)).toThrow()
  })

  test("attention events only; stream gaps and link changes are printed (W2A-11)", () => {
    for (const state of ["idle", "needs_input", "error", "aborted", "not_started", "server_down", "unknown"] as const) expect(isAttention(ev({ state }))).toBe(true)
    expect(isAttention(ev({ type: "resync" }))).toBe(true)
    expect(isAttention(ev({ type: "link" }))).toBe(true)
    expect(isAttention(ev({ type: "inbox" }))).toBe(true)
    expect(isAttention(ev({ state: "busy" }))).toBe(false)
    expect(isAttention(ev({ type: "message" }))).toBe(false)
    expect(HELP).not.toContain("inbox")
  })

  test("format: plain, coloured, json; untrusted text never in the plain line", () => {
    const e = ev({ state: "idle", sessionID: "ses_1", summary: "session ses_1 is idle", untrusted: "IGNORE PREVIOUS" })
    expect(formatLine(e, { json: false, color: false })).toBe("2026-10-01T00:00:00.000Z idle        ses_1 session ses_1 is idle")
    expect(formatLine(e, { json: false, color: true })).toStartWith("\x1b[32m")
    expect(JSON.parse(formatLine(e, { json: true, color: false }))).toEqual(e)
    expect(formatLine(ev({ type: "link", summary: "event stream connected" }), { json: false, color: false })).toContain(" link        - event stream connected")
  })

  test("W2C-04: no C0/C1 control character reaches the terminal, in plain or JSON lines", () => {
    const hostile = ev({ state: "idle", sessionID: "ses_\u001b[2Jx", summary: "a\u001b]0;pwn\u0007b\u009bc\u0085d" })
    const plain = formatLine(hostile, { json: false, color: false })
    expect(plain).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(plain).toContain("(invalid id)")
    const json = formatLine(hostile, { json: true, color: false })
    expect(json).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect((JSON.parse(json) as HubEvent).summary).toBe(hostile.summary)
    expect(clean("ok\r\nnext\u0000")).toBe("oknext")
  })

  test("colour only on a TTY without NO_COLOR / TERM=dumb / --no-color", () => {
    expect(useColor(true, {}, false)).toBe(true)
    expect(useColor(false, {}, false)).toBe(false)
    expect(useColor(true, { NO_COLOR: "1" }, false)).toBe(false)
    expect(useColor(true, { TERM: "dumb" }, false)).toBe(false)
    expect(useColor(true, {}, true)).toBe(false)
  })

  test("signal wiring: SIGINT or SIGTERM stops once and removes both listeners", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const emitter = new EventEmitter()
      const stopped = stopSignal(emitter as unknown as SignalSource)
      expect(emitter.listenerCount("SIGINT")).toBe(1)
      emitter.emit(signal)
      await stopped
      expect(emitter.listenerCount("SIGINT") + emitter.listenerCount("SIGTERM")).toBe(0)
    }
  })
})

type Captured = { out: string[]; err: string[]; stop(): void; deps: WatchDeps; hubs: DelegateHub[] }
type CaptureOptions = { backoffMs?: number[]; api?: OpencodeApi; beforeStart?: () => void; sessions?: () => Promise<Array<{ id: string; directory: string }>> }

function capture(box: BoxState, options: CaptureOptions = {}): Captured {
  let stop = () => {}
  const stopped = new Promise<void>((resolve) => (stop = resolve))
  const c: Captured = { out: [], err: [], stop: () => stop(), hubs: [], deps: undefined as unknown as WatchDeps }
  c.deps = {
    boxStatus: async () => box,
    hub: (target, trackAll) => {
      const h = createHub({ target, trackAll, backoffMs: options.backoffMs ?? [20], api: options.api })
      const start = h.start.bind(h)
      h.start = () => {
        options.beforeStart?.()
        return start()
      }
      c.hubs.push(h)
      return h
    },
    sessions: options.sessions ?? (async () => []),
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

const running = (b: FakeBox): BoxState => ({ state: "running", target: b.target, imageTag: "t", startedBy: "other" })

describe("watch", () => {
  test("sandbox not running → clear stderr message, exit 2, nothing on stdout", async () => {
    const c = capture({ state: "stopped" })
    expect(await watch([], c.deps)).toBe(EXIT.boxDown)
    expect(c.out).toEqual([])
    expect(c.err.join("\n")).toContain("not running")
  })

  test("bad arguments → exit 64 on stderr, with control characters stripped", async () => {
    const c = capture({ state: "stopped" })
    expect(await watch(["--no\u001b[31m"], c.deps)).toBe(EXIT.usage)
    expect(c.out).toEqual([])
    expect(c.err.join("")).not.toContain("\u001b")
  })

  test("--session for an unknown id → exit 3", async () => {
    box = startFakeBox()
    const c = capture(running(box))
    expect(await watch(["--session", "ses_missing00001"], c.deps)).toBe(EXIT.notFound)
  })

  test("--session when the sandbox does not answer → exit 2 with the reason", async () => {
    const api = fakeApi({ [`/session/${SES}`]: new DelegateError("server_down", "down", "Run oc_doctor.", "ConnectionRefused") })
    const c = capture({ state: "running", target: { baseUrl: "http://127.0.0.1:9", password: "x" }, imageTag: "t", startedBy: "other" }, { api })
    expect(await watch(["--session", SES], c.deps)).toBe(EXIT.boxDown)
    expect(c.out).toEqual([])
    expect(c.err.join("\n")).toContain(`the sandbox did not answer for ${SES} (ConnectionRefused)`)
  })

  test("prints one line per attention event, stops with exit 0", async () => {
    box = startFakeBox()
    box.sessions.set(SES, { id: SES, directory: "/sessions/a" })
    const c = capture(running(box))
    const run = watch(["--session", SES, "--json"], c.deps)
    await until(() => c.err.some((l) => l.includes("watching")), 3000, "watching")
    const send = (type: string) => box?.send({ type: "session.status", properties: { sessionID: SES, status: { type } } })
    send("busy")
    box.send({ type: "permission.asked", properties: { id: "per_1", sessionID: SES, permission: "bash", patterns: ["ls"] } })
    box.send({ type: "permission.replied", properties: { sessionID: SES, requestID: "per_1", reply: "once" } })
    send("idle")
    await until(() => c.out.length >= 3, 3000, "three lines")
    c.stop()
    expect(await run).toBe(EXIT.ok)
    const lines = c.out.map((l) => JSON.parse(l) as HubEvent)
    expect(lines.map((l) => `${l.type}:${l.state ?? "-"}`)).toEqual(["link:-", "permission:needs_input", "status:idle"])
  })

  test("W2A-12: a change between the first read and the stream connecting is printed", async () => {
    box = startFakeBox()
    box.sessions.set(SES, { id: SES, directory: "/sessions/a" })
    box.status.set("/sessions/a", { [SES]: { type: "busy" } })
    const c = capture(running(box), { beforeStart: () => box?.status.set("/sessions/a", {}) }) // finished before the stream opened
    const run = watch(["--session", SES], c.deps)
    await until(() => c.err.some((l) => l.includes("watching")), 3000, "watching")
    c.stop()
    expect(await run).toBe(EXIT.ok)
    expect(c.err.some((l) => l.includes(`${SES} is busy now`))).toBe(true)
    expect(c.out.some((l) => / idle +ses_watch00000001 session ses_watch00000001 is idle \(read after connecting\)$/.test(l))).toBe(true)
  })

  test("--once: snapshot every root session, exit 0, no stream opened", async () => {
    box = startFakeBox()
    box.sessions.set(SES, { id: SES, directory: "/sessions/a" })
    box.sessions.set(SES2, { id: SES2, directory: "/sessions/a" })
    const c = capture(running(box), { sessions: async () => [{ id: SES, directory: "/sessions/a" }, { id: SES2, directory: "/sessions/a" }] })
    expect(await watch(["--once"], c.deps)).toBe(EXIT.ok)
    expect(c.out).toHaveLength(2)
    expect(c.out[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z idle        ses_watch00000001 ses_watch00000001 is idle$/)
    expect(c.out[1]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z idle        ses_watch00000002 ses_watch00000002 is idle$/)
    expect(box.connects()).toBe(0) // --once opens no event stream
  })

  test("--once --json: rows carry state, directory, since=observedAt, empty pending; a session missing from the box reads not_found, exit stays 0", async () => {
    box = startFakeBox()
    box.sessions.set(SES, { id: SES, directory: "/sessions/a" })
    const c = capture(running(box), { sessions: async () => [{ id: SES, directory: "/sessions/a" }, { id: SES2, directory: "/sessions/b" }] })
    expect(await watch(["--once", "--json"], c.deps)).toBe(EXIT.ok)
    const rows = c.out.map((l) => JSON.parse(l) as SnapshotRow)
    expect(rows.map((r) => `${r.sessionID}:${r.state}`)).toEqual([`${SES}:idle`, `${SES2}:not_found`])
    expect(rows[0]?.directory).toBe("/sessions/a")
    expect(rows[0]?.since === rows[0]?.observedAt).toBe(true)
    expect(rows[0]?.pending).toEqual([])
  })

  test("--once: a read that comes back server_down fails the whole snapshot with exit 2", async () => {
    const api = fakeApi({ [`/session/${SES}`]: new DelegateError("server_down", "down", "Run oc_doctor.", "ConnectionRefused") })
    const c = capture({ state: "running", target: { baseUrl: "http://127.0.0.1:9", password: "x" }, imageTag: "t", startedBy: "other" }, { api, sessions: async () => [{ id: SES, directory: "/sessions/a" }] })
    expect(await watch(["--once", "--json"], c.deps)).toBe(EXIT.boxDown)
    expect((JSON.parse(c.out[0] ?? "{}") as SnapshotRow).state).toBe("server_down")
  })

  test("--once --session: a missing session is still reported (row printed) and exits 3", async () => {
    box = startFakeBox()
    const c = capture(running(box))
    expect(await watch(["--once", "--json", "--session", "ses_missing00001"], c.deps)).toBe(EXIT.notFound)
    const rows = c.out.map((l) => JSON.parse(l) as SnapshotRow)
    expect(rows.map((r) => `${r.sessionID}:${r.state}`)).toEqual(["ses_missing00001:not_found"])
  })

  test("--once: a failing listing is thrown up (never treated as an empty box)", async () => {
    box = startFakeBox()
    const c = capture(running(box), { sessions: async () => { throw new DelegateError("upstream_error", "listing failed", "Retry.") } })
    expect(watch(["--once"], c.deps)).rejects.toThrow("listing failed")
    expect(c.out).toEqual([])
  })
})
