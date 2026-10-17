/** @jsxImportSource @opentui/solid */
// Fork (#176): late events and an in-flight sync must not bring a deleted session's entries back.
import { describe, expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { createDeletedSessions, eventSessionID } from "../../../../src/context/deleted-sessions"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

function info(id: string) {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    title: id,
    time: { created: 1, updated: 1 },
    version: "1.15.13",
    directory: "/tmp/opencode/packages/opencode",
  }
}

function assistant(sessionID: string, id: string) {
  return {
    id,
    sessionID,
    role: "assistant" as const,
    agent: "build",
    modelID: "model",
    providerID: "test",
    mode: "build",
    parentID: "msg_user",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 2 },
  }
}

describe("deleted sessions (#176)", () => {
  test("late events of a busy deleted session do not re-create its entries", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)
    const sessionID = "ses_late_busy"
    const messageID = "msg_late_busy"

    try {
      emit(global({ id: "evt_s", type: "session.updated", properties: { sessionID, info: info(sessionID) } }))
      emit(global({ id: "evt_d", type: "session.deleted", properties: { sessionID, info: info(sessionID) } }))
      // The reply was still running: the server keeps publishing after the delete.
      emit(global({ id: "evt_m", type: "message.updated", properties: { sessionID, info: assistant(sessionID, messageID) } }))
      emit(
        global({
          id: "evt_p",
          type: "message.part.updated",
          properties: {
            sessionID,
            time: 3,
            part: { id: "prt_late_busy", sessionID, messageID, type: "text", text: "late" },
          },
        }),
      )
      emit(global({ id: "evt_st", type: "session.status", properties: { sessionID, status: { type: "busy" } } }))
      emit(global({ id: "evt_t", type: "todo.updated", properties: { sessionID, todos: [] } }))
      emit(global({ id: "evt_df", type: "session.diff", properties: { sessionID, diff: [] } }))
      emit(global({ id: "evt_su", type: "session.updated", properties: { sessionID, info: info(sessionID) } }))
      // A later event for another session proves delivery went on.
      emit(global({ id: "evt_o", type: "session.updated", properties: { sessionID: "ses_other", info: info("ses_other") } }))
      await wait(() => sync.data.session.some((s) => s.id === "ses_other"))

      expect(sync.data.session.some((s) => s.id === sessionID)).toBe(false)
      expect(sync.data.message[sessionID]).toBeUndefined()
      expect(sync.data.part[messageID]).toBeUndefined()
      expect(sync.data.session_status[sessionID]).toBeUndefined()
      expect(sync.data.todo[sessionID]).toBeUndefined()
      expect(sync.data.session_diff[sessionID]).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("a sync still fetching when the session is deleted writes nothing back", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_late_sync"
    const messageID = "msg_late_sync"
    let resolveMessages!: (response: Response) => void
    const messages = new Promise<Response>((resolve) => {
      resolveMessages = resolve
    })
    let requested = false
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) return json(info(sessionID))
      if (url.pathname === `/session/${sessionID}/message`) {
        requested = true
        return messages
      }
      if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
      return undefined
    }, tmp.path)

    try {
      const hydrate = sync.session.sync(sessionID)
      await wait(() => requested)
      emit(global({ id: "evt_d", type: "session.deleted", properties: { sessionID, info: info(sessionID) } }))
      emit(global({ id: "evt_o", type: "session.updated", properties: { sessionID: "ses_other", info: info("ses_other") } }))
      await wait(() => sync.data.session.some((s) => s.id === "ses_other"))

      resolveMessages(
        json([
          {
            info: assistant(sessionID, messageID),
            parts: [{ id: "prt_late_sync", sessionID, messageID, type: "text", text: "stale" }],
          },
        ]),
      )
      await hydrate

      expect(sync.data.session.some((s) => s.id === sessionID)).toBe(false)
      expect(sync.data.message[sessionID]).toBeUndefined()
      expect(sync.data.part[messageID]).toBeUndefined()
      expect(sync.data.todo[sessionID]).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
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
