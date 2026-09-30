// MOD-03: cursor buffer — ring size, epochs, paging, and wait() (manual clock).
import { describe, expect, test } from "bun:test"
import { EventBuffer, matchesUntil, type HubEventInput } from "../src/events/buffer.ts"
import { DelegateError } from "../src/shared/errors.ts"
import type { HubEvent } from "../src/shared/contracts.ts"
import { manualTimers } from "./events-fake.ts"

const ev = (sessionID: string, state: HubEventInput["state"], type: HubEventInput["type"] = "status"): HubEventInput => ({ type, sessionID, state, summary: `${sessionID} ${state}` })

describe("EventBuffer", () => {
  test("keeps the last N events; a cursor that fell off the ring is expired", () => {
    const b = new EventBuffer("ep1", manualTimers().timers, 3)
    for (let i = 0; i < 5; i++) b.append(ev(`ses_${i}`, "busy"))
    const page = b.page(undefined)
    expect(page.events.map((e) => e.cursor.seq)).toEqual([3, 4, 5])
    expect(b.page({ epoch: "ep1", seq: 1 }).expired).toBe(true)
    expect(b.page({ epoch: "ep1", seq: 2 }).events.length).toBe(3)
  })

  test("a cursor from another epoch → expired:true + the current head", () => {
    const b = new EventBuffer("ep1", manualTimers().timers)
    b.append(ev("ses_1", "busy"))
    expect(b.page({ epoch: "old", seq: 1 })).toEqual({ events: [], next: { epoch: "ep1", seq: 1 }, expired: true })
  })

  test("paging: filter by session, limit, next advances past scanned events", () => {
    const b = new EventBuffer("ep1", manualTimers().timers)
    b.append(ev("ses_1", "busy"))
    b.append(ev("ses_2", "busy"))
    b.append(ev("ses_1", "idle"))
    const first = b.page(undefined, { sessionID: "ses_1" }, 1)
    expect(first.events.map((e) => e.state)).toEqual(["busy"])
    const second = b.page(first.next, { sessionID: "ses_1" }, 5)
    expect(second.events.map((e) => e.state)).toEqual(["idle"])
    expect(second.next.seq).toBe(3)
    expect(b.page(second.next).events).toEqual([])
  })

  test("wait returns already-buffered matches after the cursor at once", async () => {
    const b = new EventBuffer("ep1", manualTimers().timers)
    const start = b.head()
    b.append(ev("ses_1", "busy"))
    b.append(ev("ses_1", "idle"))
    const r = await b.wait({ sessionIDs: ["ses_1"], until: ["idle"], timeoutMs: 1000, cursor: start })
    expect(r.timedOut).toBe(false)
    expect(r.events.map((e) => e.state)).toEqual(["idle"])
    expect(r.next).toEqual(b.head())
  })

  test("wait long-polls until the first match, ignoring other sessions and states", async () => {
    const t = manualTimers()
    const b = new EventBuffer("ep1", t.timers)
    const p = b.wait({ sessionIDs: ["ses_1"], until: ["idle"], timeoutMs: 5000 })
    b.append(ev("ses_2", "idle"))
    b.append(ev("ses_1", "busy"))
    const hit = b.append(ev("ses_1", "idle"))
    const r = await p
    expect(r.events).toEqual([hit])
    expect(r.next).toEqual(hit.cursor)
    expect(t.pending()).toBe(0) // the timeout timer was cancelled
  })

  test("wait times out on the injected clock", async () => {
    const t = manualTimers()
    const b = new EventBuffer("ep1", t.timers)
    const p = b.wait({ sessionIDs: [], until: ["idle"], timeoutMs: 240_000 })
    t.advance(240_000)
    expect(await p).toEqual({ events: [], next: b.head(), timedOut: true })
  })

  test("wait with a foreign cursor rejects with cursor_expired", async () => {
    const b = new EventBuffer("ep1", manualTimers().timers)
    const error = await b.wait({ sessionIDs: [], until: ["idle"], timeoutMs: 10, cursor: { epoch: "old", seq: 0 } }).catch((e: unknown) => e)
    expect(error instanceof DelegateError && error.code).toBe("cursor_expired")
  })

  test("close() resolves pending waits as timed out", async () => {
    const t = manualTimers()
    const b = new EventBuffer("ep1", t.timers)
    const p = b.wait({ sessionIDs: [], until: ["idle"], timeoutMs: 60_000 })
    b.close()
    expect((await p).timedOut).toBe(true)
    expect(t.pending()).toBe(0)
  })
})

describe("until mapping", () => {
  const e = (x: Partial<HubEvent>): HubEvent => ({ cursor: { epoch: "e", seq: 1 }, at: "", type: "status", summary: "", ...x })
  test("idle / needs_input / error / message", () => {
    expect(matchesUntil(e({ state: "idle" }), "idle")).toBe(true)
    expect(matchesUntil(e({ state: "busy" }), "idle")).toBe(false)
    expect(matchesUntil(e({ type: "permission", state: "needs_input" }), "needs_input")).toBe(true)
    expect(matchesUntil(e({ type: "question", state: "needs_input" }), "needs_input")).toBe(true)
    expect(matchesUntil(e({ type: "status", state: "needs_input" }), "needs_input")).toBe(false)
    for (const state of ["error", "not_started", "server_down"] as const) expect(matchesUntil(e({ state }), "error")).toBe(true)
    expect(matchesUntil(e({ state: "unknown" }), "error")).toBe(false)
    expect(matchesUntil(e({ type: "message" }), "message")).toBe(true)
    expect(matchesUntil(e({ type: "inbox" }), "message")).toBe(true)
    expect(matchesUntil(e({ type: "todo" }), "message")).toBe(false)
  })
})
