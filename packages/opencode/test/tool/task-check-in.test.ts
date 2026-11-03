import { describe, expect, test } from "bun:test"
import { runningPromotedTask } from "../../src/tool/task-check-in"

describe("runningPromotedTask", () => {
  test("a running promoted job uses the check-in", () => {
    expect(runningPromotedTask({ status: "running", metadata: { background: true } })).toBe(true)
  })

  test("a finished promoted job keeps its real result", () => {
    expect(runningPromotedTask({ status: "completed", metadata: { background: true } })).toBe(false)
    expect(runningPromotedTask({ status: "error", metadata: { background: true } })).toBe(false)
    expect(runningPromotedTask({ status: "cancelled", metadata: { background: true } })).toBe(false)
  })

  test("a running job that was not promoted does not use the check-in", () => {
    expect(runningPromotedTask({ status: "running" })).toBe(false)
    expect(runningPromotedTask(undefined)).toBe(false)
  })
})
