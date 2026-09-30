// MOD-03 T3.2: one test per absent-state row (technical-design §6, plan §5 FM-0), plus the
// ordinary transitions. Rows:
//   R1 stream dropped before idle        → unknown (stream_gap) for every tracked session, until rebuilt
//   R2 absent from /session/status, 200  → idle (confirmed by GET /session/:id)
//   R3 absent from /session/status, 404  → not_found
//   R4 prompt_async 204, no busy in 10 s → not_started
//   R5 server unreachable                → server_down
//   R6 permission/question pending       → needs_input even while upstream says busy
//   R7 silence                           → never idle (starting, then not_started)
import { describe, expect, test } from "bun:test"
import { safe, statusEvent } from "../src/events/describe.ts"
import { createHub } from "../src/events/hub.ts"
import { SENT_SLACK_MS, SessionTable, type SnapshotEntry } from "../src/events/state.ts"
import { DelegateError } from "../src/shared/errors.ts"
import { fakeApi, manualTimers } from "./events-fake.ts"

const DIR = "/sessions/a"
const target = { baseUrl: "http://127.0.0.1:9", password: "x" }

function upTable(start = 1_000_000) {
  let now = start
  const table = new SessionTable(() => now)
  table.track("ses_1", DIR)
  table.rebuild(new Map()) // link up, nothing learned yet
  return { table, tick: (ms: number) => (now += ms) }
}

const snap = (entries: Record<string, SnapshotEntry>) => new Map(Object.entries(entries))

describe("absent-state rows", () => {
  test("R1: a dropped stream makes every tracked session unknown(stream_gap) until a rebuild", () => {
    const { table } = upTable()
    table.track("ses_2", DIR)
    table.status("ses_1", "busy")
    const changes = table.setLink({ kind: "gap", detail: "closed: stream ended" })
    expect(changes.map((c) => [c.sessionID, c.state])).toEqual([["ses_1", "unknown"], ["ses_2", "unknown"]])
    expect(table.get("ses_1")?.detail).toContain("stream_gap")
    // An idle that the stream never delivered is not assumed: still unknown.
    expect(table.get("ses_1")?.state).toBe("unknown")
    table.rebuild(snap({ ses_1: { base: "idle", pending: [] }, ses_2: { base: "busy", pending: [] } }))
    expect(table.get("ses_1")?.state).toBe("idle")
    expect(table.get("ses_2")?.state).toBe("busy")
  })

  test("R2: absent from /session/status but GET /session/:id 200 → idle", async () => {
    const api = fakeApi({
      [`/session/status?${DIR}`]: { status: 200, data: {} },
      [`/permission?${DIR}`]: { status: 200, data: [] },
      [`/question?${DIR}`]: { status: 200, data: [] },
      [`/session/ses_1?${DIR}`]: { status: 200, data: { id: "ses_1", directory: DIR } },
    })
    const hub = createHub({ target, api, timers: manualTimers().timers })
    hub.track("ses_1", DIR)
    const view = await hub.view("ses_1")
    expect(view.state).toBe("idle")
    expect(api.calls).toContain(`/session/ses_1?${DIR}`)
  })

  test("R3: absent from /session/status and GET /session/:id 404 → not_found", async () => {
    const api = fakeApi({ [`/session/status?${DIR}`]: { status: 200, data: {} }, [`/permission?${DIR}`]: { status: 200, data: [] }, [`/question?${DIR}`]: { status: 200, data: [] } })
    const hub = createHub({ target, api, timers: manualTimers().timers })
    hub.track("ses_gone", DIR)
    expect((await hub.view("ses_gone")).state).toBe("not_found")
    // An id the hub never tracked: its directory comes from GET /session/:id, which 404s.
    expect((await hub.view("ses_never")).state).toBe("not_found")
  })

  test("R4: prompt accepted but no busy within 10 s → not_started", () => {
    const { table, tick } = upTable()
    tick(60_000)
    table.markSent("ses_1")
    expect(table.get("ses_1")?.state).toBe("starting")
    tick(10_000)
    const changes = table.startTimeout("ses_1")
    expect(changes[0]?.state).toBe("not_started")
    expect(table.get("ses_1")?.state).toBe("not_started")
  })

  test("R5: server unreachable → server_down (link) and in view()", async () => {
    const { table } = upTable()
    const changes = table.setLink({ kind: "down", detail: "server unreachable (ConnectionRefused)" })
    expect(changes[0]?.state).toBe("server_down")
    const api = fakeApi({ "/session/ses_1": new DelegateError("server_down", "down", "Run oc_doctor.") })
    const hub = createHub({ target, api, timers: manualTimers().timers })
    expect((await hub.view("ses_1")).state).toBe("server_down")
  })

  test("R6: a pending permission or question is needs_input even while upstream says busy", () => {
    const { table } = upTable()
    table.status("ses_1", "busy")
    table.ask("ses_1", "per_1", "permission")
    table.status("ses_1", "busy") // upstream keeps saying busy
    expect(table.get("ses_1")?.state).toBe("needs_input")
    table.ask("ses_1", "que_1", "question")
    table.answered("ses_1", "per_1")
    expect(table.get("ses_1")?.state).toBe("needs_input")
    expect(table.get("ses_1")?.pending).toEqual(["que_1"])
    table.answered("ses_1", "que_1")
    expect(table.get("ses_1")?.state).toBe("busy")
  })

  test("R6: view() reports needs_input from GET /permission while /session/status says busy", async () => {
    const api = fakeApi({
      [`/session/status?${DIR}`]: { status: 200, data: { ses_1: { type: "busy" } } },
      [`/permission?${DIR}`]: { status: 200, data: [{ id: "per_9", sessionID: "ses_1" }] },
      [`/question?${DIR}`]: { status: 200, data: [] },
    })
    const hub = createHub({ target, api, timers: manualTimers().timers })
    hub.track("ses_1", DIR)
    const view = await hub.view("ses_1")
    expect(view.state).toBe("needs_input")
    expect(view.pending).toEqual(["per_9"])
  })

  test("R7: silence is never idle — tracked + sent with no events stays starting, then not_started", () => {
    const { table, tick } = upTable()
    tick(60_000)
    table.markSent("ses_1")
    tick(9_000)
    expect(table.get("ses_1")?.state).toBe("starting")
    tick(1_000)
    table.startTimeout("ses_1")
    expect(table.get("ses_1")?.state).toBe("not_started")
  })

  test("R7: a tracked session with nothing learned is unresolved, which view() must resolve via the server", () => {
    const { table } = upTable()
    expect(table.get("ses_1")?.state).toBe("unresolved")
  })
})

describe("transitions", () => {
  test("busy ⇄ retry → idle", () => {
    const { table } = upTable()
    expect(table.status("ses_1", "busy")[0]?.state).toBe("busy")
    expect(table.status("ses_1", "retry", 2)[0]?.detail).toBe("retry attempt 2")
    expect(table.status("ses_1", "busy")[0]?.state).toBe("busy")
    expect(table.status("ses_1", "idle")[0]?.state).toBe("idle")
  })

  test("error and aborted stay visible through the idle that follows them; busy clears them", () => {
    const { table } = upTable()
    table.status("ses_1", "busy")
    table.error("ses_1", "APIError", false)
    table.status("ses_1", "idle")
    expect(table.get("ses_1")?.state).toBe("error")
    table.status("ses_1", "busy")
    table.error("ses_1", "MessageAbortedError", true)
    table.status("ses_1", "idle")
    expect(table.get("ses_1")?.state).toBe("aborted")
    table.status("ses_1", "busy")
    expect(table.get("ses_1")?.state).toBe("busy")
  })

  test("session.deleted → not_found", () => {
    const { table } = upTable()
    table.ask("ses_1", "per_1", "permission")
    expect(table.deleted("ses_1")[0]?.state).toBe("not_found")
  })

  test("markSent after an already-seen busy (event beat the 204) does not reset to starting", () => {
    const { table, tick } = upTable()
    table.status("ses_1", "busy")
    table.markSent("ses_1")
    expect(table.get("ses_1")?.state).toBe("busy")
    table.status("ses_1", "idle") // very fast reply, finished before markSent was called
    tick(SENT_SLACK_MS - 1)
    table.markSent("ses_1")
    expect(table.get("ses_1")?.state).toBe("idle")
    expect(table.awaitingStart("ses_1")).toBe(false)
  })

  test("the not_started watchdog claims nothing during a gap; rebuild decides", () => {
    const { table, tick } = upTable()
    tick(60_000)
    table.markSent("ses_1")
    table.setLink({ kind: "gap", detail: "closed" })
    tick(10_000)
    expect(table.startTimeout("ses_1")).toEqual([])
    table.rebuild(snap({ ses_1: { base: "idle", pending: [] } }))
    expect(table.get("ses_1")?.state).toBe("not_started")
  })

  test("rebuild showing busy counts as started", () => {
    const { table, tick } = upTable()
    tick(60_000)
    table.markSent("ses_1")
    table.setLink({ kind: "gap", detail: "closed" })
    table.rebuild(snap({ ses_1: { base: "busy", pending: [] } }))
    tick(10_000)
    expect(table.startTimeout("ses_1")).toEqual([])
    expect(table.get("ses_1")?.state).toBe("busy")
  })

  test("status summaries keep readable details and neutralise odd characters", () => {
    const { table } = upTable()
    const [change] = table.deleted("ses_1")
    expect(change && statusEvent(change).summary).toBe("session ses_1 is not_found (session deleted)")
    expect(safe("bash\n<script>")).toBe("bash??script?")
  })

  test("events for untracked sessions change nothing", () => {
    const { table } = upTable()
    expect(table.status("ses_other", "busy")).toEqual([])
    expect(table.has("ses_other")).toBe(false)
  })
})
