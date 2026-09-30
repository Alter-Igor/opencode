// MOD-03 T3.1: SSE parsing, reconnect backoff and the heartbeat watchdog (manual timers).
import { describe, expect, test } from "bun:test"
import { normalise, unwrap } from "../src/events/normalise.ts"
import { BACKOFF_MS, STALE_MS, SseParser, runStream, type Drop } from "../src/events/sse.ts"
import { manualTimers, until } from "./events-fake.ts"

const target = { baseUrl: "http://127.0.0.1:9", password: "x" }

describe("SseParser", () => {
  test("events split across chunks at any byte", () => {
    const text = 'data: {"a":1}\n\ndata: {"b":2}\n\n'
    for (let cut = 1; cut < text.length; cut++) {
      const p = new SseParser()
      expect([...p.push(text.slice(0, cut)), ...p.push(text.slice(cut))]).toEqual(['{"a":1}', '{"b":2}'])
    }
  })

  test("multi-line data joins with \\n; comments, other fields and empty data are ignored", () => {
    const p = new SseParser()
    expect(p.push(": keep-alive\nevent: message\nid: 7\ndata: line1\ndata:line2\n\ndata:\n\n")).toEqual(["line1\nline2"])
  })

  test("CRLF and lone CR terminators, including a CRLF split across chunks", () => {
    const p = new SseParser()
    expect(p.push("data: x\r")).toEqual([])
    // The final CR may be half of a CRLF, so "y" completes only when the next byte arrives.
    expect(p.push("\n\r\ndata: y\r\r")).toEqual(["x"])
    expect(p.push("data: z\n\n")).toEqual(["y", "z"])
  })

  test("an incomplete event is held until its blank line", () => {
    const p = new SseParser()
    expect(p.push("data: part")).toEqual([])
    expect(p.push("ial\n")).toEqual([])
    expect(p.push("\n")).toEqual(["partial"])
  })
})

describe("normalise", () => {
  test("wrapper → typed raw; unknown and malformed input is dropped, never thrown", () => {
    const w = unwrap(JSON.stringify({ directory: "/d", payload: { id: "e", type: "session.status", properties: { sessionID: "ses_1", status: { type: "retry", attempt: 2, message: "rate limited", next: 1 } } } }))
    expect(w?.directory).toBe("/d")
    expect(w && normalise(w)).toEqual({ kind: "status", sessionID: "ses_1", status: "retry", attempt: 2 })
    expect(unwrap("not json")).toBeUndefined()
    expect(unwrap("[1,2]")).toBeUndefined()
    const odd = unwrap(JSON.stringify({ payload: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "weird" } } } }))
    expect(odd && normalise(odd)).toEqual({ kind: "ignored", type: "session.status" })
    const error = unwrap(JSON.stringify({ payload: { type: "session.error", properties: { sessionID: "ses_1", error: { name: "MessageAbortedError", data: { message: "x" } } } } }))
    expect(error && normalise(error)).toEqual({ kind: "error", sessionID: "ses_1", name: "MessageAbortedError", aborted: true })
  })
})

function failingFetch(): typeof fetch {
  return (() => Promise.reject(new TypeError("connection refused"))) as unknown as typeof fetch
}

describe("runStream", () => {
  test("backoff is 1/2/5/10 s and stays at 10 s", async () => {
    const t = manualTimers()
    const drops: Drop[] = []
    const s = runStream(target, { onOpen() {}, onData() {}, onDrop: (d) => drops.push(d) }, { timers: t.timers, fetch: failingFetch() })
    for (let i = 0; i < 5; i++) {
      await until(() => drops.length > i, 2000, `drop ${i}`)
      t.advance(20_000)
    }
    await s.stop()
    expect(t.delays.filter((d) => d !== STALE_MS).slice(0, 5)).toEqual([...BACKOFF_MS, 10_000])
    expect(drops[0]?.kind).toBe("unreachable")
  })

  test("a connection that opened resets the backoff", async () => {
    const t = manualTimers()
    let n = 0
    const fetchImpl = (async () => {
      n++
      if (n !== 3) throw new TypeError("refused")
      return new Response(new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new TextEncoder().encode("data: {}\n\n")), c.close()) }))
    }) as unknown as typeof fetch
    const drops: Drop[] = []
    let opens = 0
    const s = runStream(target, { onOpen: () => opens++, onData() {}, onDrop: (d) => drops.push(d) }, { timers: t.timers, fetch: fetchImpl })
    for (let i = 0; i < 4; i++) {
      await until(() => drops.length > i, 2000, `drop ${i}`)
      t.advance(20_000)
    }
    await s.stop()
    expect(opens).toBe(1)
    expect(drops[2]?.kind).toBe("closed")
    expect(t.delays.filter((d) => d !== STALE_MS).slice(0, 4)).toEqual([1000, 2000, 1000, 2000])
  })

  test("no bytes for 30 s → the stream is dropped as stale", async () => {
    const t = manualTimers()
    let keepAlive: ReturnType<typeof setTimeout> | undefined
    const silent = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: () => void (keepAlive = setTimeout(() => {}, 60_000)), // hold a real timer; never enqueue
          cancel: () => clearTimeout(keepAlive),
        }),
      )) as unknown as typeof fetch
    const drops: Drop[] = []
    let opened = false
    const s = runStream(target, { onOpen: () => (opened = true), onData() {}, onDrop: (d) => drops.push(d) }, { timers: t.timers, fetch: silent })
    await until(() => opened, 2000, "open")
    t.advance(STALE_MS - 1)
    await Bun.sleep(20)
    expect(drops.length).toBe(0)
    t.advance(1)
    await until(() => drops.length > 0, 2000, "stale drop")
    expect(drops[0]?.kind).toBe("stale")
    await s.stop()
    clearTimeout(keepAlive)
  })

  test("a non-2xx answer is an http drop, not server_down", async () => {
    const t = manualTimers()
    const drops: Drop[] = []
    const s = runStream(target, { onOpen() {}, onData() {}, onDrop: (d) => drops.push(d) }, { timers: t.timers, fetch: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch })
    await until(() => drops.length > 0)
    await s.stop()
    expect(drops[0]).toEqual({ kind: "http", detail: "HTTP 401" })
  })
})
