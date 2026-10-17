/** @jsxImportSource @opentui/solid */
// Fork (#215): part events for messages outside the loaded window must not leave orphan parts.
import { describe, expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { freeSessionParts, unlistedMessage } from "../../../../src/context/part-window"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

function info(id: string) {
  return { id, slug: id, projectID: "proj_test", title: id, time: { created: 1, updated: 1 }, version: "1.15.13", directory: "/tmp" }
}

function assistant(sessionID: string, id: string, created: number) {
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
    time: { created, completed: created + 1 },
  }
}

function part(sessionID: string, messageID: string, id: string) {
  return { id, sessionID, messageID, type: "text" as const, text: id }
}

describe("part window (#215)", () => {
  test("in a synced session a part of an unlisted message is dropped; a part of a listed one is kept", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_window"
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) return json(info(sessionID))
      if (url.pathname === `/session/${sessionID}/message`)
        return json([
          { info: assistant(sessionID, "msg_0002", 2), parts: [] },
          { info: assistant(sessionID, "msg_0003", 3), parts: [] },
        ])
      if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
      return undefined
    }, tmp.path)

    try {
      await sync.session.sync(sessionID)
      // Compaction prune touching a part of an old message the window does not hold.
      emit(global({ id: "p1", type: "message.part.updated", properties: { sessionID, time: 4, part: part(sessionID, "msg_0001", "prt_old") } }))
      // A new message: the server publishes message.updated before its parts.
      emit(global({ id: "m4", type: "message.updated", properties: { sessionID, info: assistant(sessionID, "msg_0004", 4) } }))
      emit(global({ id: "p4", type: "message.part.updated", properties: { sessionID, time: 5, part: part(sessionID, "msg_0004", "prt_new") } }))
      await wait(() => sync.data.part["msg_0004"] !== undefined)

      expect(sync.data.part["msg_0001"]).toBeUndefined()
      expect(sync.data.part["msg_0004"]?.[0]?.id).toBe("prt_new")
    } finally {
      app.renderer.destroy()
    }
  })

  test("in a session that is not synced, a part of an unlisted message is kept as before", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)
    const sessionID = "ses_unsynced"

    try {
      emit(global({ id: "m2", type: "message.updated", properties: { sessionID, info: assistant(sessionID, "msg_0002", 2) } }))
      emit(global({ id: "p1", type: "message.part.updated", properties: { sessionID, time: 3, part: part(sessionID, "msg_0001", "prt_kept") } }))
      await wait(() => sync.data.part["msg_0001"] !== undefined)
      expect(sync.data.part["msg_0001"]?.[0]?.id).toBe("prt_kept")
    } finally {
      app.renderer.destroy()
    }
  })

  test("deleting a session frees its parts even for messages the store no longer lists", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)
    const sessionID = "ses_orphans"

    try {
      emit(global({ id: "s", type: "session.updated", properties: { sessionID, info: info(sessionID) } }))
      // No messages loaded for the session yet, so this part is kept, with no listed message.
      emit(global({ id: "p", type: "message.part.updated", properties: { sessionID, time: 1, part: part(sessionID, "msg_unlisted", "prt_orphan") } }))
      emit(global({ id: "o", type: "message.part.updated", properties: { sessionID: "ses_other", time: 1, part: part("ses_other", "msg_other", "prt_other") } }))
      await wait(() => sync.data.part["msg_unlisted"] !== undefined && sync.data.part["msg_other"] !== undefined)

      emit(global({ id: "d", type: "session.deleted", properties: { sessionID, info: info(sessionID) } }))
      await wait(() => !sync.data.session.some((s) => s.id === sessionID))

      expect(sync.data.part["msg_unlisted"]).toBeUndefined()
      expect(sync.data.part["msg_other"]?.[0]?.id).toBe("prt_other")
    } finally {
      app.renderer.destroy()
    }
  })

  test("unlistedMessage and freeSessionParts", () => {
    expect(unlistedMessage(undefined, "msg_1")).toBe(false)
    expect(unlistedMessage([], "msg_1")).toBe(true)
    expect(unlistedMessage([{ id: "msg_5" }, { id: "msg_3" }], "msg_3")).toBe(false)
    expect(unlistedMessage([{ id: "msg_5" }, { id: "msg_3" }], "msg_9")).toBe(true)
    const parts: Record<string, Array<{ sessionID?: string }> | undefined> = { a: [{ sessionID: "x" }], b: [{ sessionID: "y" }] }
    freeSessionParts(parts, "x")
    expect(Object.keys(parts)).toEqual(["b"])
  })
})
