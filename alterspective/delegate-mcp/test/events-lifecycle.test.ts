// MOD-03 Wave 2 review fixes on a manual clock: the hub over a scripted SSE stream (fakeStream)
// and a fake API, so the not_started watchdog, wait() re-checks and gap handling run exactly.
import { afterEach, describe, expect, test } from "bun:test"
import { createHub, type DelegateHub } from "../src/events/hub.ts"
import { fakeApi, fakeStream, manualTimers, until, type FakeStream, type ManualTimers, type Route } from "./events-fake.ts"

const DIR = "/sessions/a"
const target = { baseUrl: "http://127.0.0.1:9", password: "x" }
const status = (type: string, sessionID = "ses_1") => ({ type: "session.status", properties: { sessionID, status: { type } } })

type Rig = { t: ManualTimers; s: FakeStream; routes: Record<string, Route>; hub: DelegateHub }
let hub: DelegateHub | undefined

afterEach(async () => {
  await hub?.stop()
  hub = undefined
})

async function rig(backoffMs: number[] = [1000]): Promise<Rig> {
  const t = manualTimers()
  const s = fakeStream()
  const routes: Record<string, Route> = {
    [`/session/status?${DIR}`]: { status: 200, data: {} },
    [`/permission?${DIR}`]: { status: 200, data: [] },
    [`/question?${DIR}`]: { status: 200, data: [] },
    [`/session/ses_1?${DIR}`]: { status: 200, data: { id: "ses_1", directory: DIR } },
  }
  hub = createHub({ target, api: fakeApi(routes), fetch: s.fetch, timers: t.timers, staleMs: 100_000_000, backoffMs, notStartedMs: 10_000 })
  await hub.start()
  hub.track("ses_1", DIR)
  return { t, s, routes, hub }
}

const stateOf = async (h: DelegateHub) => (await h.view("ses_1")).state
const types = (h: DelegateHub) => h.events(undefined, {}, 200).events.map((e) => `${e.type}:${e.state ?? "-"}`)

describe("not_started watchdog (W2A-01)", () => {
  test("send #1 → busy → idle → send #2: the first send's timer never marks the second not_started early", async () => {
    const { t, s, hub: h } = await rig()
    h.markSent("ses_1") // t0: send #1
    s.send(status("busy"))
    await until(() => types(h).includes("status:busy"), 2000, "busy")
    s.send(status("idle"))
    await until(() => types(h).at(-1) === "status:idle", 2000, "idle")
    t.advance(8000)
    h.markSent("ses_1") // t0 + 8 s: send #2
    expect(await stateOf(h)).toBe("starting")
    t.advance(2500) // t0 + 10.5 s: when send #1's watchdog would have fired
    expect(await stateOf(h)).toBe("starting")
    t.advance(7500) // t0 + 18 s: send #2's own window is over
    expect(await stateOf(h)).toBe("not_started")
  })
})

describe("wait() settles from state as well as events (W2A-05/06)", () => {
  test("without a cursor, a session already idle returns at once with its view", async () => {
    const { hub: h } = await rig()
    const result = await h.wait({ sessionIDs: ["ses_1"], until: ["idle"], timeoutMs: 60_000 })
    expect(result.timedOut).toBe(false)
    expect(result.events).toEqual([])
    expect(result.views?.[0]).toMatchObject({ sessionID: "ses_1", state: "idle" })
    expect(result.next).toEqual(h.cursor())
  })

  test("a session still starting does not match; the wait times out on the clock", async () => {
    const { t, hub: h } = await rig()
    h.markSent("ses_1")
    const waiting = h.wait({ sessionIDs: ["ses_1"], until: ["idle"], timeoutMs: 5000, cursor: h.cursor() })
    await Bun.sleep(5)
    t.advance(5000)
    const result = await waiting
    expect(result.timedOut).toBe(true)
  })

  test("before a timeout the state is re-read: a run that ended in a gap still settles the wait", async () => {
    const { t, s, hub: h } = await rig([60_000])
    s.send(status("busy"))
    await until(() => types(h).includes("status:busy"), 2000, "busy")
    s.drop() // the idle is lost; no reconnect within the wait (backoff 60 s)
    await until(() => types(h).includes("status:unknown"), 2000, "unknown")
    const waiting = h.wait({ sessionIDs: ["ses_1"], until: ["idle"], timeoutMs: 5000, cursor: h.cursor() })
    await Bun.sleep(5)
    t.advance(5000)
    const result = await waiting
    expect(result.timedOut).toBe(false)
    expect(result.views?.[0]?.state).toBe("idle")
  })
})

describe("in-stream gaps (W2A-17 / W2C-01)", () => {
  test("an event over 1 MB is discarded, every session goes unknown, and state is rebuilt on the same connection", async () => {
    const { s, routes, hub: h } = await rig()
    s.send(status("busy"))
    await until(() => types(h).includes("status:busy"), 2000, "busy")
    routes[`/session/status?${DIR}`] = { status: 200, data: {} }
    s.raw(`data: ${"x".repeat(1024 * 1024 + 10)}\n\n`)
    await until(() => types(h).at(-1) === "status:idle", 3000, "rebuilt idle")
    expect(types(h)).toEqual(["link:-", "status:busy", "status:unknown", "status:idle"])
    expect(s.opens()).toBe(1)
  })
})
