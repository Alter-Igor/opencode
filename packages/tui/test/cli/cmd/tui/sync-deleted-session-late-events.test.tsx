// Fork (#176): late events and an in-flight sync must not bring a deleted session's entries back.
import { describe, expect, test } from "bun:test"
import { createDeletedSessions, eventSessionID } from "@opencode/client/solid"

describe("deleted sessions (#176)", () => {
  test("filter and omit drop only deleted sessions", () => {
    const deleted = createDeletedSessions()
    expect(deleted.filter([{ id: "a" }])).toEqual([{ id: "a" }])
    deleted.add("a")
    expect(deleted.filter([{ id: "a" }, { id: "b" }])).toEqual([{ id: "b" }])
    expect(deleted.omit({ a: 1, b: 2 })).toEqual({ b: 2 })
  })

  test("eventSessionID reads the session from each event shape", () => {
    expect(eventSessionID({ type: "session.status", properties: { sessionID: "a" } })).toBe("a")
    expect(eventSessionID({ type: "message.updated", properties: { info: { id: "msg", sessionID: "b" } } })).toBe("b")
    expect(eventSessionID({ type: "session.updated", properties: { info: { id: "c" } } })).toBe("c")
    expect(eventSessionID({ type: "message.part.updated", properties: { part: { sessionID: "d" } } })).toBe("d")
    expect(eventSessionID({ type: "lsp.updated", properties: {} })).toBeUndefined()
  })

  test("the deleted set forgets the oldest ID past its limit", () => {
    const deleted = createDeletedSessions(2)
    deleted.add("a")
    deleted.add("b")
    deleted.add("c")
    expect([deleted.has("a"), deleted.has("b"), deleted.has("c")]).toEqual([false, true, true])
    expect(deleted.ignores({ type: "session.deleted", properties: { sessionID: "b" } })).toBe(false)
    expect(deleted.ignores({ type: "todo.updated", properties: { sessionID: "b" } })).toBe(true)
  })
})
