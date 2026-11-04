// Fork (#215): part events for messages outside the loaded window must not leave orphan parts.
import { describe, expect, test } from "bun:test"
import { freeSessionParts, unlistedMessage } from "@opencode/client/solid"

describe("part window (#215)", () => {
  test("unlistedMessage and freeSessionParts", () => {
    expect(unlistedMessage(undefined, "msg_1")).toBe(false)
    expect(unlistedMessage([], "msg_1")).toBe(true)
    expect(unlistedMessage([{ id: "msg_5" }, { id: "msg_3" }], "msg_3")).toBe(false)
    expect(unlistedMessage([{ id: "msg_5" }, { id: "msg_3" }], "msg_9")).toBe(true)
    const parts: Record<string, Array<{ sessionID?: string }> | undefined> = {
      a: [{ sessionID: "x" }],
      b: [{ sessionID: "y" }],
    }
    freeSessionParts(parts, "x")
    expect(Object.keys(parts)).toEqual(["b"])
  })
})
