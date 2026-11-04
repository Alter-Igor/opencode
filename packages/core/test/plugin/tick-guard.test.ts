import { describe, expect, test } from "bun:test"
import { childTickStatus, factsLine, shouldSendTick, skipToast, type TickMessage } from "../../src/plugin/tick-guard"

function user(synthetic = false): TickMessage {
  return {
    info: { role: "user", ...(synthetic ? { synthetic: true } : {}) },
    parts: [{ synthetic: synthetic || undefined }],
  }
}

function assistant(): TickMessage {
  return { info: { role: "assistant" }, parts: [{}] }
}

describe("shouldSendTick", () => {
  test("busy or retry never sends", () => {
    const messages = [user(), assistant()]
    expect(shouldSendTick({ status: "busy", messages })).toEqual({ send: false, reason: "busy" })
    expect(shouldSendTick({ status: "retry", messages })).toEqual({ send: false, reason: "busy" })
  })

  test("a real user with no assistant after it is unanswered", () => {
    expect(shouldSendTick({ status: "idle", messages: [user(), assistant(), user()] })).toEqual({
      send: false,
      reason: "unanswered",
    })
  })

  test("an answered real user sends, and a synthetic user does not count", () => {
    expect(shouldSendTick({ status: "idle", messages: [user(), assistant()] }).send).toBe(true)
    expect(shouldSendTick({ status: "idle", messages: [user(true)] }).send).toBe(true)
    expect(shouldSendTick({ status: "idle", messages: [user(), assistant(), user(true)] }).send).toBe(true)
  })
})

describe("tick facts", () => {
  test("facts line and skip toasts count children and hide message text", () => {
    const children = [
      { id: "ses_a", status: "working" as const },
      { id: "ses_b", status: "idle" as const },
      { id: "ses_c", status: "failed" as const },
    ]
    expect(factsLine({ status: "idle", children: [children[0]] })).toBe(
      "[tick] status=idle children=1 working, 0 idle, 0 failed",
    )
    expect(skipToast("busy", [children[0]])).toBe("Tick skipped, session busy. Children: 1 working, 0 idle, 0 failed.")
    expect(skipToast("unanswered", [children[1]])).toBe(
      "Tick skipped, a message is still waiting. Children: 0 working, 1 idle, 0 failed.",
    )
    expect(factsLine({ status: "retry", children })).toBe("[tick] status=retry children=1 working, 1 idle, 1 failed")
    expect(childTickStatus({ type: "busy" })).toBe("working")
    expect(childTickStatus({ type: "retry" })).toBe("working")
    expect(childTickStatus({ type: "idle", error: "boom" })).toBe("failed")
    expect(childTickStatus({ type: "idle" })).toBe("idle")
    expect(childTickStatus(undefined)).toBe("idle")
  })
})
