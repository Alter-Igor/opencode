// MOD-03 T3.1/T3.3: the hub against a fake OpenCode server over real HTTP and SSE.
// Short real timers (backoff 20-100 ms, not_started 150 ms; stale 200 ms in its own test) keep it fast.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHub, type DelegateHub, type HubOptions } from "../src/events/hub.ts"
import type { HubEvent } from "../src/shared/contracts.ts"
import { startFakeBox, until, type FakeBox } from "./events-fake.ts"

const DIR = "/sessions/a"
let box: FakeBox
let hub: DelegateHub | undefined

beforeEach(() => {
  box = startFakeBox()
  box.sessions.set("ses_1", { id: "ses_1", directory: DIR })
})
afterEach(async () => {
  await hub?.stop()
  hub = undefined
  await box.stop()
})

function make(extra: Partial<HubOptions> = {}): DelegateHub {
  hub = createHub({ target: box.target, backoffMs: [20, 40, 50, 100], staleMs: 2000, notStartedMs: 150, ...extra })
  return hub
}

const all = (h: DelegateHub): HubEvent[] => h.events(undefined, {}, 200).events
const seq = (h: DelegateHub, id = "ses_1") => all(h).filter((e) => e.sessionID === id).map((e) => `${e.type}:${e.state ?? "-"}`)
const status = (type: string, sessionID = "ses_1") => ({ type: "session.status", properties: { sessionID, status: { type } } })

describe("event hub over SSE", () => {
  test("busy → idle for a tracked session; untracked sessions are filtered out", async () => {
    const h = make()
    await h.start()
    h.track("ses_1", DIR)
    box.send(status("busy"))
    box.send(status("busy", "ses_other"))
    box.send({ type: "session.idle", properties: { sessionID: "ses_1" } }) // deprecated: ignored
    box.send(status("idle"))
    await until(() => seq(h).length >= 2, 3000, "busy+idle")
    expect(seq(h)).toEqual(["status:busy", "status:idle"])
    expect(all(h).some((e) => e.sessionID === "ses_other")).toBe(false)
    expect((await h.view("ses_1")).state).toBe("idle")
  })

  test("kill the stream mid-task: unknown(stream_gap), then resync rebuilds idle from the server", async () => {
    const h = make()
    await h.start()
    h.track("ses_1", DIR)
    box.status.set(DIR, { ses_1: { type: "busy" } })
    box.send(status("busy"))
    await until(() => seq(h).includes("status:busy"))
    const before = box.connects()
    box.status.set(DIR, {}) // finished while the stream was down: absent = idle, but only GET /session/:id can say so
    box.dropStreams()
    await until(() => seq(h).includes("status:unknown"), 3000, "unknown")
    await until(() => all(h).some((e) => e.type === "resync"), 3000, "resync")
    await until(() => seq(h).at(-1) === "status:idle", 3000, "rebuilt idle")
    expect(box.connects()).toBeGreaterThan(before)
    expect(seq(h)).toEqual(["status:busy", "status:unknown", "status:idle"])
    expect(box.requests).toContain(`GET /session/ses_1?${DIR}`)
    expect(box.requests).toContain(`GET /permission?${DIR}`)
    expect(box.requests).toContain(`GET /question?${DIR}`)
  })

  test("a session deleted during the gap is rebuilt as not_found, never idle", async () => {
    const h = make()
    await h.start()
    h.track("ses_1", DIR)
    box.send(status("busy"))
    await until(() => seq(h).includes("status:busy"))
    box.sessions.delete("ses_1")
    box.dropStreams()
    await until(() => seq(h).at(-1) === "status:not_found", 3000, "not_found")
    expect(seq(h)).not.toContain("status:idle")
  })

  test("server down → server_down for tracked sessions; back up → resync and rebuilt state", async () => {
    const h = make()
    await h.start()
    h.track("ses_1", DIR)
    box.send(status("busy"))
    await until(() => seq(h).includes("status:busy"))
    await box.down()
    await until(() => seq(h).includes("status:server_down"), 3000, "server_down")
    expect((await h.view("ses_1")).state).toBe("server_down")
    box.status.set(DIR, { ses_1: { type: "retry", attempt: 3 } })
    await box.up()
    await until(() => seq(h).at(-1) === "status:retry", 3000, "rebuilt retry")
    expect(all(h).filter((e) => e.type === "resync").length).toBeGreaterThanOrEqual(1)
  })

  test("a heartbeat-less stream is dropped as stale after the watchdog and reconnected", async () => {
    const h = make({ staleMs: 200 })
    await h.start()
    h.track("ses_1", DIR)
    const before = box.connects()
    await until(() => box.connects() > before, 3000, "reconnect after stale")
    expect(seq(h)).toContain("status:unknown")
  })

  test("permission asked while busy → needs_input event with the request id; wait(needs_input) returns it", async () => {
    const h = make()
    await h.start()
    h.track("ses_1", DIR)
    box.send(status("busy"))
    await until(() => seq(h).includes("status:busy"))
    const waiting = h.wait({ sessionIDs: ["ses_1"], until: ["needs_input"], timeoutMs: 3000, cursor: h.events(undefined).next })
    box.send({ type: "permission.asked", properties: { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["rm -rf /tmp/x"], metadata: {}, always: [] } })
    const result = await waiting
    expect(result.timedOut).toBe(false)
    expect(result.events[0]).toMatchObject({ type: "permission", state: "needs_input", requestID: "per_1" })
    expect(result.events[0]?.summary).not.toContain("rm -rf")
    box.send({ type: "permission.replied", properties: { sessionID: "ses_1", requestID: "per_1", reply: "once" } })
    await until(() => seq(h).at(-1) === "status:busy", 3000, "back to busy")
  })

  test("markSent with no busy → not_started, which wait(error) reports", async () => {
    const h = make()
    await h.start()
    h.track("ses_1", DIR)
    const waiting = h.wait({ sessionIDs: ["ses_1"], until: ["error"], timeoutMs: 3000 })
    h.markSent("ses_1")
    expect((await h.view("ses_1")).state).toBe("starting")
    const result = await waiting
    expect(result.events[0]?.state).toBe("not_started")
  })

  test("only the final assistant text part becomes a message event, truncated to 500 in untrusted", async () => {
    const h = make()
    await h.start()
    h.track("ses_1", DIR)
    const long = "x".repeat(900)
    const part = (id: string, messageID: string, text: string, end?: number) => ({ type: "message.part.updated", properties: { sessionID: "ses_1", time: 1, part: { id, sessionID: "ses_1", messageID, type: "text", text, time: { start: 1, end } } } })
    box.send({ type: "message.updated", properties: { sessionID: "ses_1", info: { id: "msg_u", sessionID: "ses_1", role: "user" } } })
    box.send(part("prt_u", "msg_u", "user text", 2))
    box.send({ type: "message.updated", properties: { sessionID: "ses_1", info: { id: "msg_a", sessionID: "ses_1", role: "assistant" } } })
    box.send(part("prt_a", "msg_a", "streaming…"))
    box.send(part("prt_a", "msg_a", long, 5))
    box.send(part("prt_a", "msg_a", long, 5)) // repeated update: reported once
    box.send(status("idle"))
    await until(() => seq(h).includes("status:idle"))
    const messages = all(h).filter((e) => e.type === "message")
    expect(messages.length).toBe(1)
    expect(messages[0]?.untrusted?.length).toBe(501)
    expect(messages[0]?.summary).not.toContain("xxx")
  })

  test("mcp.tools.changed only for tracked directories", async () => {
    const h = make()
    await h.start()
    h.track("ses_1", DIR)
    box.send({ type: "mcp.tools.changed", properties: { server: "ks-delegate" } }, "/sessions/other")
    box.send({ type: "mcp.tools.changed", properties: { server: "ks-delegate" } }, DIR)
    box.send(status("busy"))
    await until(() => seq(h).includes("status:busy"))
    const mcp = all(h).filter((e) => e.type === "mcp")
    expect(mcp.map((e) => e.directory)).toEqual([DIR])
  })

  test("trackAll tracks sessions seen on the stream (watch CLI)", async () => {
    const h = make({ trackAll: true })
    await h.start()
    box.send(status("busy", "ses_new"), "/sessions/b")
    await until(() => seq(h, "ses_new").length > 0)
    expect(all(h).find((e) => e.sessionID === "ses_new")?.directory).toBe("/sessions/b")
  })

  test("subscribe gets each event once; a throwing subscriber does not break the hub", async () => {
    const h = make()
    const got: string[] = []
    h.subscribe(() => {
      throw new Error("boom")
    })
    const off = h.subscribe((e) => got.push(e.type))
    await h.start()
    h.track("ses_1", DIR)
    box.send(status("busy"))
    await until(() => got.includes("status"))
    off()
    h.publish({ type: "inbox", summary: "message from supervisor:a" })
    expect(got).toEqual(["status"])
    expect(all(h).at(-1)?.type).toBe("inbox")
  })

  test("start() resolves when the server is down, and view() says server_down", async () => {
    await box.down()
    const h = make()
    await h.start()
    h.track("ses_1", DIR)
    expect((await h.view("ses_1")).state).toBe("server_down")
    await box.up()
  })
})
