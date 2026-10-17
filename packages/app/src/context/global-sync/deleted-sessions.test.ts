// Fork (#214): late events of a deleted session must not re-create its entries in the web app.
import { describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { applyDirectoryEvent } from "./event-reducer"
import { dropDeletedSessionEvent, eventSessionID, isDeletedSessionEvent, markSessionDeleted } from "./deleted-sessions"

const session = (id: string) => ({ id, time: { created: 1, updated: 1 } }) as Session

const state = (input: Partial<State> = {}) =>
  ({
    status: "complete",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } as State["path"],
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 10,
    message: {},
    session_message: {},
    part: {},
    part_text_accum_delta: {},
    ...input,
  }) as State

describe("deleted sessions in the web app (#214)", () => {
  test("late events of a deleted session do not re-create its entries; other sessions still update", () => {
    const [store, setStore] = createStore(state({ session: [session("ses_gone")], sessionTotal: 1 }))
    const apply = (event: { type: string; properties?: unknown }) =>
      applyDirectoryEvent({ event, store, setStore, push() {}, directory: "/tmp", loadLsp() {} })

    apply({ type: "session.deleted", properties: { sessionID: "ses_gone", info: session("ses_gone") } })
    const message = { id: "msg_late", sessionID: "ses_gone", role: "user", time: { created: 2 } } as Message
    apply({ type: "message.updated", properties: { sessionID: "ses_gone", info: message } })
    apply({
      type: "message.part.updated",
      properties: { sessionID: "ses_gone", part: { id: "prt_late", sessionID: "ses_gone", messageID: "msg_late", type: "text", text: "x" } as Part },
    })
    apply({ type: "session.updated", properties: { sessionID: "ses_gone", info: session("ses_gone") } })
    apply({ type: "session.status", properties: { sessionID: "ses_gone", status: { type: "busy" } } })
    apply({ type: "session.updated", properties: { sessionID: "ses_kept", info: session("ses_kept") } })

    expect(store.session.map((s) => s.id)).toEqual(["ses_kept"])
    expect(store.message["ses_gone"]).toBeUndefined()
    expect(store.part["msg_late"]).toBeUndefined()
    expect(store.session_status["ses_gone"]).toBeUndefined()
  })

  test("a session.created for a deleted ID brings it back (opencode import keeps IDs)", () => {
    const store = {}
    markSessionDeleted(store, "ses_x")
    expect(isDeletedSessionEvent(store, { type: "session.status", properties: { sessionID: "ses_x" } })).toBe(true)
    expect(isDeletedSessionEvent(store, { type: "session.created", properties: { info: { id: "ses_x" } } })).toBe(false)
    expect(isDeletedSessionEvent(store, { type: "session.status", properties: { sessionID: "ses_x" } })).toBe(false)
  })

  test("each store keeps its own deleted IDs, and eventSessionID reads each event shape", () => {
    const a = {}
    const b = {}
    markSessionDeleted(a, "ses_1")
    expect(isDeletedSessionEvent(b, { type: "todo.updated", properties: { sessionID: "ses_1" } })).toBe(false)
    expect(eventSessionID({ type: "message.updated", properties: { info: { id: "m", sessionID: "s" } } })).toBe("s")
    expect(eventSessionID({ type: "session.updated", properties: { info: { id: "s2" } } })).toBe("s2")
    expect(eventSessionID({ type: "message.part.updated", properties: { part: { sessionID: "s3" } } })).toBe("s3")
    expect(eventSessionID({ type: "x", properties: {}, current: { type: "session.moved", data: { sessionID: "s4" } } })).toBe(
      "s4",
    )
  })

  test("a store forgets its oldest deleted ID after 200, and an event with no properties passes", () => {
    const store = {}
    for (let i = 0; i < 201; i++) markSessionDeleted(store, `ses_${i}`)
    expect(isDeletedSessionEvent(store, { type: "session.status", properties: { sessionID: "ses_0" } })).toBe(false)
    expect(isDeletedSessionEvent(store, { type: "session.status", properties: { sessionID: "ses_1" } })).toBe(true)
    expect(isDeletedSessionEvent(store, { type: "session.status", properties: { sessionID: "ses_200" } })).toBe(true)
    expect(isDeletedSessionEvent(store, { type: "session.status" })).toBe(false)
  })

  test("the server-wide guard marks a deleted session and drops its later events", () => {
    const key = {}
    expect(dropDeletedSessionEvent(key, { type: "session.deleted", properties: { info: { id: "ses_d" } } })).toBe(false)
    expect(dropDeletedSessionEvent(key, { type: "message.updated", properties: { info: { id: "m", sessionID: "ses_d" } } })).toBe(
      true,
    )
    expect(dropDeletedSessionEvent(key, { type: "session.updated", properties: { info: { id: "ses_d" } } })).toBe(true)
    expect(dropDeletedSessionEvent(key, { type: "session.status", properties: { sessionID: "ses_other" } })).toBe(false)
    expect(dropDeletedSessionEvent(key, { type: "server.connected", properties: {} })).toBe(false)
  })

  test("server-sync drops a deleted session's events before the session cache, home list and reducer see them", async () => {
    const source = await Bun.file(new URL("../server-sync.tsx", import.meta.url)).text()
    const guard = source.indexOf("if (dropDeletedSessionEvent(session, event)) return")
    expect(guard).toBeGreaterThan(-1)
    for (const call of ["session.applyV2(event.current)", "session.apply(event)", "homeSessions.apply(event)"])
      expect(source.indexOf(call)).toBeGreaterThan(guard)
  })
})
