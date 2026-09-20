import { describe, expect, test } from "bun:test"
import { extractToolCallsFromModelOutput } from "../../src/plugin/synapse"

const OPEN = "<" + "tool_call" + ">"
const CLOSE = "<" + "/tool_call" + ">"
const WRONG = "<" + "/result" + ">"
const WRONG2 = "<" + "/function_calls" + ">"

describe("extractToolCallsFromModelOutput tolerant close", () => {
  test("recovers a call closed by mismatched tags", () => {
    const out = extractToolCallsFromModelOutput(
      `Working.\n${OPEN} {"name": "keystone-dynamic_execute-tool", "arguments": {"toolName": "list-orgs", "arguments": {}}} ${WRONG} ${WRONG2}`,
    )
    expect(out.toolCalls.length).toBe(1)
    expect(out.toolCalls[0].function.name).toBe("keystone-dynamic_execute-tool")
    expect(JSON.parse(out.toolCalls[0].function.arguments)).toEqual({ toolName: "list-orgs", arguments: {} })
    expect(out.cleanText).toBe("Working.")
  })

  test("still handles the well-formed close", () => {
    const out = extractToolCallsFromModelOutput(`${OPEN}{"name": "read", "arguments": {"filePath": "a"}}${CLOSE}`)
    expect(out.toolCalls.length).toBe(1)
    expect(out.cleanText).toBe("")
  })

  test("garbage after an open tag does not throw", () => {
    const out = extractToolCallsFromModelOutput(`${OPEN} not json at all ${WRONG}`)
    expect(out.toolCalls.length).toBe(0)
  })
})
