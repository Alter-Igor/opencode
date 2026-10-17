/** @jsxImportSource @opentui/solid */
// Fork (#215): part events for messages outside the loaded window must not leave orphan parts.
import { describe, expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { freeSessionParts, outsideWindow } from "../../../../src/context/part-window"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait } from "./sync-fixture"

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
  test("a part of a message older than the loaded window is dropped; a newer one is kept", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)
    const sessionID = "ses_window"

    try {
      emit(global({ id: "m2", type: "message.updated", properties: { sessionID, info: assistant(sessionID, "msg_0002", 2) } }))
      emit(global({ id: "m3", type: "message.updated", properties: { sessionID, info: assistant(sessionID, "msg_0003", 3) } }))
      // Compaction prune touching a part of an old message the window no longer holds.
      emit(global({ id: "p1", type: "message.part.updated", properties: { sessionID, time: 4, part: part(sessionID, "msg_0001", "prt_old") } }))
      // A part of a new message whose message.updated has not arrived yet.
      emit(global({ id: "p4", type: "message.part.updated", properties: { sessionID, time: 5, part: part(sessionID, "msg_0004", "prt_new") } }))
      await wait(() => sync.data.part["msg_0004"] !== undefined)

      expect(sync.data.part["msg_0001"]).toBeUndefined()
      expect(sync.data.part["msg_0004"]?.[0]?.id).toBe("prt_new")
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

  test("outsideWindow and freeSessionParts", () => {
    expect(outsideWindow(undefined, "msg_1")).toBe(false)
    expect(outsideWindow([], "msg_1")).toBe(false)
    expect(outsideWindow([{ id: "msg_5" }, { id: "msg_3" }], "msg_2")).toBe(true)
    expect(outsideWindow([{ id: "msg_5" }, { id: "msg_3" }], "msg_3")).toBe(false)
    expect(outsideWindow([{ id: "msg_5" }, { id: "msg_3" }], "msg_4")).toBe(false)
    const parts: Record<string, Array<{ sessionID?: string }> | undefined> = { a: [{ sessionID: "x" }], b: [{ sessionID: "y" }] }
    freeSessionParts(parts, "x")
    expect(Object.keys(parts)).toEqual(["b"])
  })
})
