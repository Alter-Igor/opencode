// MOD-03 T3.1: SSE parsing, reconnect backoff and the heartbeat watchdog (manual timers).
import { describe, expect, test } from "bun:test"
import { normalise, unwrap } from "../src/events/normalise.ts"
import { BACKOFF_MS, MAX_EVENT_CHARS, STALE_MS, SseParser, runStream, type Drop } from "../src/events/sse.ts"
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

  test("W2A-17/W2C-01: an 8 MB line in 16 KB chunks is linear, bounded, reported once, and the next event still parses", () => {
    const p = new SseParser()
    const chunk = "x".repeat(16 * 1024)
    const started = performance.now()
    let peak = 0
    expect(p.push("data: ")).toEqual([])
    for (let i = 0; i < 512; i++) {
      p.push(chunk)
      peak = Math.max(peak, p.buffered())
    }
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(200)
    expect(peak).toBeLessThanOrEqual(MAX_EVENT_CHARS + chunk.length)
    expect(p.buffered()).toBe(0)
    expect(p.takeOverflow()).toBe(true)
    expect(p.takeOverflow()).toBe(false)
    // The rest of the oversized event (more lines) is discarded up to its blank line.
    expect(p.push('\ndata: {"still":"dropped"}\n\ndata: {"ok":1}\n\n')).toEqual(['{"ok":1}'])
  })

  test("W2C-01: many data lines that together pass the cap count as one oversized event", () => {
    const p = new SseParser(100)
    const line = `data: ${"y".repeat(30)}\n`
    expect(p.push(line.repeat(5) + "\n")).toEqual([])
    expect(p.takeOverflow()).toBe(true)
    expect(p.push("data: small\n\n")).toEqual(["small"])
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

  const wire = (type: string, properties: Record<string, unknown>, directory?: string) => {
    const w = unwrap(JSON.stringify({ directory, payload: { id: "evt", type, properties } }))
    return w && normalise(w)
  }

  test("question asked / replied / rejected wire shapes", () => {
    expect(wire("question.asked", { id: "que_1", sessionID: "ses_1", questions: [{ question: "a?" }, { question: "b?" }] })).toEqual({ kind: "question.asked", sessionID: "ses_1", requestID: "que_1", count: 2 })
    expect(wire("question.replied", { sessionID: "ses_1", requestID: "que_1", answers: [["x"]] })).toEqual({ kind: "question.done", sessionID: "ses_1", requestID: "que_1", rejected: false })
    expect(wire("question.rejected", { sessionID: "ses_1", requestID: "que_1" })).toEqual({ kind: "question.done", sessionID: "ses_1", requestID: "que_1", rejected: true })
  })

  test("W2C-03: a request id that is not an OpenCode id is dropped, never echoed", () => {
    expect(wire("permission.asked", { id: "per_\u001b[2J", sessionID: "ses_1", permission: "bash", patterns: [] })).toEqual({ kind: "ignored", type: "permission.asked" })
    expect(wire("permission.replied", { sessionID: "ses_1", requestID: "not-an-id", reply: "once" })).toEqual({ kind: "ignored", type: "permission.replied" })
    expect(wire("question.asked", { id: `que_${"a".repeat(37)}`, sessionID: "ses_1", questions: [] })).toEqual({ kind: "ignored", type: "question.asked" })
  })

  test("todo, session.deleted, session.created/updated and dispose wire shapes", () => {
    expect(wire("todo.updated", { sessionID: "ses_1", todos: [{ status: "completed" }, { status: "pending" }, "junk"] })).toEqual({ kind: "todo", sessionID: "ses_1", total: 3, done: 1 })
    expect(wire("session.deleted", { sessionID: "ses_1", info: { id: "ses_1" } })).toEqual({ kind: "deleted", sessionID: "ses_1" })
    expect(wire("session.deleted", { info: { id: "ses_2" } })).toEqual({ kind: "deleted", sessionID: "ses_2" })
    expect(wire("session.created", { sessionID: "ses_k", info: { id: "ses_k", parentID: "ses_1", directory: "/d" } })).toEqual({ kind: "info", sessionID: "ses_k", parentID: "ses_1", directory: "/d" })
    expect(wire("session.updated", { info: { id: "ses_1", title: "t" } })).toEqual({ kind: "info", sessionID: "ses_1", parentID: undefined, directory: undefined })
    expect(wire("server.instance.disposed", { directory: "/d" }, "/d")).toEqual({ kind: "disposed", directory: "/d" })
    expect(wire("global.disposed", {}, "global")).toEqual({ kind: "disposed", directory: "all" })
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

  // Opens on attempt 3 and closes at once; `healthy` says whether the hub rebuilt state on it.
  async function openAndClose(healthy: boolean): Promise<{ delays: number[]; opens: number; drops: Drop[] }> {
    const t = manualTimers()
    let n = 0
    const fetchImpl = (async () => {
      n++
      if (n !== 3) throw new TypeError("refused")
      return new Response(new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new TextEncoder().encode("data: {}\n\n")), c.close()) }))
    }) as unknown as typeof fetch
    const drops: Drop[] = []
    let opens = 0
    let control: ReturnType<typeof runStream> | undefined
    const onOpen = () => {
      opens++
      if (healthy) control?.healthy()
    }
    control = runStream(target, { onOpen, onData() {}, onDrop: (d) => drops.push(d) }, { timers: t.timers, fetch: fetchImpl })
    for (let i = 0; i < 4; i++) {
      await until(() => drops.length > i, 2000, `drop ${i}`)
      t.advance(20_000)
    }
    await control.stop()
    return { delays: t.delays.filter((d) => d !== STALE_MS).slice(0, 4), opens, drops }
  }

  test("W2A-09: a connection that opens but never proves healthy does not reset the backoff", async () => {
    const r = await openAndClose(false)
    expect(r.opens).toBe(1)
    expect(r.drops[2]?.kind).toBe("closed")
    expect(r.delays).toEqual([1000, 2000, 5000, 10_000])
  })

  test("a connection the hub marked healthy resets the backoff", async () => {
    const r = await openAndClose(true)
    expect(r.delays).toEqual([1000, 2000, 1000, 2000])
  })

  test("W2C-02: the stream request refuses redirects (redirect:error, and a 3xx is an http drop)", async () => {
    const t = manualTimers()
    const drops: Drop[] = []
    let mode: RequestRedirect | undefined
    const fetchImpl = (async (_url: URL, init: RequestInit) => {
      mode = init.redirect
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/x" } })
    }) as unknown as typeof fetch
    const s = runStream(target, { onOpen() {}, onData() {}, onDrop: (d) => drops.push(d) }, { timers: t.timers, fetch: fetchImpl })
    await until(() => drops.length > 0)
    await s.stop()
    expect(mode).toBe("error")
    expect(drops[0]).toEqual({ kind: "http", detail: "redirect refused, HTTP 302" })
  })

  test("W2C-02: a real 302 from the box is refused, never followed", async () => {
    let followed = false
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/elsewhere" ? ((followed = true), new Response("x")) : new Response(null, { status: 302, headers: { location: "/elsewhere" } })) })
    const t = manualTimers()
    const drops: Drop[] = []
    const s = runStream({ baseUrl: `http://127.0.0.1:${server.port}`, password: "x" }, { onOpen() {}, onData() {}, onDrop: (d) => drops.push(d) }, { timers: t.timers })
    await until(() => drops.length > 0)
    await s.stop()
    await server.stop(true)
    expect(drops[0]?.kind).toBe("http")
    expect(drops[0]?.detail).toContain("redirect refused")
    expect(followed).toBe(false)
  })

  test("W2C-01: an oversized event inside a live stream is reported through onGap", async () => {
    const t = manualTimers()
    let keepAlive: ReturnType<typeof setInterval> | undefined
    const big = new TextEncoder().encode(`data: ${"z".repeat(MAX_EVENT_CHARS + 1)}\n\ndata: {"after":1}\n\n`)
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => {
            keepAlive = setInterval(() => {}, 1000)
            c.enqueue(big)
          },
          cancel: () => clearInterval(keepAlive),
        }),
      )) as unknown as typeof fetch
    const gaps: string[] = []
    const data: string[] = []
    const s = runStream(target, { onOpen() {}, onData: (d) => data.push(d), onDrop() {}, onGap: (d) => gaps.push(d) }, { timers: t.timers, fetch: fetchImpl })
    await until(() => gaps.length > 0)
    await s.stop()
    clearInterval(keepAlive)
    expect(data).toEqual(['{"after":1}'])
    expect(gaps[0]).toContain("over 1 MB")
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
