import { describe, expect, test } from "bun:test"
import { extractToolCallsFromModelOutput } from "../../src/plugin/synapse"

const OPEN = "<" + "tool_call" + ">"
const CLOSE = "<" + "/tool_call" + ">"
const WRONG = "<" + "/result" + ">"
const WRONG2 = "<" + "/function_calls" + ">"
const PARAM_CLOSE = "<" + "/parameter" + ">"
const FN_CLOSE = "<" + "/function" + ">"
const BS = String.fromCharCode(92)

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

  test("braces inside JSON strings do not terminate the payload early", () => {
    const payload = '{"name": "bash", "arguments": {"command": "echo ' + BS + '"a}b{' + BS + '"' + '"}}'
    const out = extractToolCallsFromModelOutput(`${OPEN} ${payload} ${WRONG}`)
    expect(out.toolCalls.length).toBe(1)
    expect(out.toolCalls[0].function.name).toBe("bash")
    expect(JSON.parse(out.toolCalls[0].function.arguments)).toEqual({ command: 'echo "a}b{"' })
  })

  test("recovers the exact live-drift shape: open tag missing its '>' and a stray '<' before the payload", () => {
    const NO_GT = "<" + "tool_call"
    const out = extractToolCallsFromModelOutput(
      `Bonjour.\n${NO_GT}\n<{"name": "keystone-dynamic", "arguments": {"action": "search-tools", "query": "list-orgs"}}\n${CLOSE}`,
    )
    expect(out.toolCalls.length).toBe(1)
    expect(out.toolCalls[0].function.name).toBe("keystone-dynamic")
    expect(JSON.parse(out.toolCalls[0].function.arguments)).toEqual({ action: "search-tools", query: "list-orgs" })
    expect(out.cleanText).toBe("Bonjour.")
  })

  test("does not false-match longer tag names like tool_calls or tool_calling", () => {
    const prose = "<" + "tool_calls" + '>{""name"": ""read""}</' + "tool_calls" + "> and <" + "tool_calling" + ">"
    const out = extractToolCallsFromModelOutput(prose)
    expect(out.toolCalls.length).toBe(0)
  })

  test("recovers a well-formed block whose interior has junk before the close (live payload)", () => {
    const junk = PARAM_CLOSE + " " + FN_CLOSE
    const out = extractToolCallsFromModelOutput(
      `${OPEN} {"name": "keystone-dynamic_execute-tool", "arguments": {"toolName": "keystone_admin_d0d11f__list-orgs", "arguments": {}}} ${junk} ${CLOSE}`,
    )
    expect(out.toolCalls.length).toBe(1)
    expect(out.toolCalls[0].function.name).toBe("keystone-dynamic_execute-tool")
    expect(JSON.parse(out.toolCalls[0].function.arguments)).toEqual({
      toolName: "keystone_admin_d0d11f__list-orgs",
      arguments: {},
    })
  })
})
