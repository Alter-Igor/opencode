// MOD-04 output shaping: the result budget (W3A-02 / W3C-04) and hidden-character stripping (W3C-05).
import { describe, expect, test } from "bun:test"
import { untrusted as hubUntrusted, UNTRUSTED_MAX } from "../src/events/describe.ts"
import { fitList, MAX_RESULT_CHARS, ok, TRUNCATION_HINT, untrusted, type ToolResult, type Truncation } from "../src/tools/shape.ts"

const textOf = (result: ToolResult): string => result.content[0]?.text ?? ""
const bodyOf = (result: ToolResult): unknown => JSON.parse(textOf(result).slice(textOf(result).indexOf("\n") + 1))
const marks = (result: ToolResult): Truncation[] => (result.structuredContent?._truncated ?? []) as Truncation[]

/** Every result: within the cap, whole JSON after the summary line, and the same data in both places. */
function expectWellFormed(result: ToolResult, max = MAX_RESULT_CHARS): void {
  expect(textOf(result).length).toBeLessThanOrEqual(max)
  expect(bodyOf(result)).toEqual(result.structuredContent)
}

const event = (i: number) => ({ seq: i, type: "message", sessionID: "ses_0123456789abcdef", summary: `session wrote a reply ${i}`, untrusted: { text: "y".repeat(400), truncated: false } })

describe("ok(): result budget", () => {
  test("a small result is unchanged: summary line, then the JSON, and structuredContent is the data", () => {
    const data = { a: 1, list: [1, 2, 3] }
    const result = ok("Three.", data)
    expect(textOf(result)).toBe(`Three.\n${JSON.stringify(data, null, 2)}`)
    expect(result.structuredContent).toBe(data)
  })

  test("a 200-event page keeps `next` (first), drops whole events from the end, and says so", () => {
    const events = Array.from({ length: 200 }, (_, i) => event(i))
    const data = { expired: false, events, next: "c:1:200" }
    const result = ok("200 events.", data)
    expectWellFormed(result)
    const out = result.structuredContent!
    expect(out.next).toBe("c:1:200")
    expect(Object.keys(out)[0]).toBe("next")
    expect(textOf(result).split("\n")[1]).toBe("{")
    expect(textOf(result).split("\n")[2]).toBe('  "next": "c:1:200",')
    const kept = out.events as Array<{ seq: number }>
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.map((e) => e.seq)).toEqual(Array.from({ length: kept.length }, (_, i) => i))
    expect(marks(result)).toEqual([{ field: "events", omitted: 200 - kept.length, hint: TRUNCATION_HINT }])
    expect(textOf(result).split("\n")[0]).toContain("see _truncated")
    // The caller's data is not touched.
    expect(data.events).toHaveLength(200)
  })

  test("the page is as full as it can be: one more whole event would not fit", () => {
    const result = ok("200 events.", { events: Array.from({ length: 200 }, (_, i) => event(i)), next: "c:1:200" })
    const kept = (result.structuredContent!.events as unknown[]).length
    const oneMore = JSON.stringify(event(kept), null, 2).length
    expect(textOf(result).length + oneMore).toBeGreaterThan(MAX_RESULT_CHARS)
  })

  test("an oversized nested array is trimmed inside its one parent item, not dropped whole", () => {
    const pending = Array.from({ length: 500 }, (_, i) => ({ requestID: `per_${i}`, untrusted: { text: "z".repeat(200), truncated: false } }))
    const result = ok("1 session.", { sessions: [{ sessionID: "ses_1", state: "needs_input", pending }], more: false })
    expectWellFormed(result)
    const sessions = result.structuredContent!.sessions as Array<{ sessionID: string; pending: unknown[] }>
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sessionID).toBe("ses_1")
    expect(sessions[0]?.pending.length).toBeGreaterThan(0)
    expect(sessions[0]?.pending.length).toBeLessThan(500)
    expect(marks(result)).toEqual([{ field: "sessions[0].pending", omitted: 500 - (sessions[0]?.pending.length ?? 0), hint: TRUNCATION_HINT }])
    expect(result.structuredContent!.more).toBe(false)
  })

  test("the largest array goes first; a small one is left whole", () => {
    const result = ok("x", { small: [1, 2, 3], big: Array.from({ length: 5000 }, (_, i) => `item-${i}-${"q".repeat(20)}`) })
    expectWellFormed(result)
    expect(result.structuredContent!.small).toEqual([1, 2, 3])
    expect(marks(result).map((m) => m.field)).toEqual(["big"])
  })

  test("no arrays to trim: only paging keys survive, with a marker naming what went", () => {
    const result = ok("big", { cursor: "c:9", still_running: true, blob: "y".repeat(40_000), other: { x: 1 } })
    expectWellFormed(result)
    expect(result.structuredContent).toEqual({ cursor: "c:9", still_running: true, _truncated: [{ field: "blob,other", omitted: 2, hint: TRUNCATION_HINT }] })
  })

  test("the cap is exact: MAX_RESULT_CHARS fits untouched, one more char is trimmed", () => {
    const summary = "edge"
    const empty = `${summary}\n${JSON.stringify({ s: "" }, null, 2)}`.length
    const exact = { s: "x".repeat(MAX_RESULT_CHARS - empty) }
    const atCap = ok(summary, exact)
    expect(textOf(atCap).length).toBe(MAX_RESULT_CHARS)
    expect(atCap.structuredContent).toBe(exact)
    const over = ok(summary, { s: "x".repeat(MAX_RESULT_CHARS - empty + 1) })
    expectWellFormed(over)
    expect(over.structuredContent!.s).toBeUndefined()
  })

  test("never mid-JSON and never over the cap, across shapes and caps", () => {
    const shapes: Array<Record<string, unknown>> = [
      { next: "c:1", events: Array.from({ length: 300 }, (_, i) => event(i)) },
      { a: Array.from({ length: 50 }, () => ({ b: Array.from({ length: 50 }, () => "w".repeat(30)) })) },
      { rows: [[1, 2], ["x".repeat(3000)], Array.from({ length: 400 }, (_, i) => i)], more: true },
      { text: "u".repeat(10_000), list: ["v".repeat(10_000)] },
    ]
    for (const max of [300, 1_000, 4_000, 12_000, MAX_RESULT_CHARS]) {
      for (const data of shapes) expectWellFormed(ok("A summary line.", data, { maxChars: max }), max)
    }
  })
})

describe("fitList", () => {
  test("keeps whole items in order while they fit, and counts the rest", () => {
    const items = ["aaaa", "bbbb", "cccc"]
    // JSON sizes 6 each, plus one separator between items.
    expect(fitList(items, 13)).toEqual({ kept: ["aaaa", "bbbb"], omitted: 1 })
    expect(fitList(items, 20)).toEqual({ kept: items, omitted: 0 })
    expect(fitList(items, 5)).toEqual({ kept: [], omitted: 3 })
    expect(fitList([10, 200, 3], 3, (n) => String(n).length)).toEqual({ kept: [10], omitted: 2 })
  })
})

// Bidi overrides and isolates, zero-width characters, word joiner, BOM, soft hyphen, and tag characters.
const HIDDEN = ["‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩", "​", "‌", "‍", "‎", "‏", "⁠", "﻿", "­", "\u{E0000}", "\u{E0001}", "\u{E0041}", "\u{E007F}"]

describe("untrusted text: hidden characters are stripped (W3C-05)", () => {
  test("tool results: every hidden character goes; tabs, newlines and ordinary Unicode stay", () => {
    for (const ch of HIDDEN) expect(untrusted(`a${ch}b`)?.text).toBe("ab")
    expect(untrusted("line 1\n\tline 2 é 中文 🙂")?.text).toBe("line 1\n\tline 2 é 中文 🙂")
    expect(untrusted("evil‮txt.exe\u{E0049}\u{E0047}")?.text).toBe("eviltxt.exe")
  })

  test("tool results: stripped before the cap, so hidden characters cannot use it up", () => {
    expect(untrusted(`${"​".repeat(20)}visible`, 7)).toEqual({ text: "visible", truncated: false })
  })

  test("hub events: every hidden character goes, controls too, before the cap and before scrubbing", () => {
    for (const ch of HIDDEN) expect(hubUntrusted(`a${ch}b`)).toBe("ab")
    expect(hubUntrusted("bell\u0007 esc\u001b[31m")).toBe("bell esc[31m")
    expect(hubUntrusted(`${"⁠".repeat(UNTRUSTED_MAX)}ok`)).toBe("ok")
    // A zero-width space inside a token no longer hides it from scrub().
    expect(hubUntrusted("Authorization: Bearer abc123​DEF456ghi789")).toBe("Authorization: Bearer [redacted]")
  })
})
