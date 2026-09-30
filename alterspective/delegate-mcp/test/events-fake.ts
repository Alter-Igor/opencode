// Test helpers for MOD-03: a fake OpenCode server over real HTTP (Bun.serve), a fake API for
// pure view() tests, and manual timers. The fake SSE body is driven by enqueue/close, never by
// waiting on an abort signal alone (that spins a core on Bun/Windows).
import type { Server } from "bun"
import type { ApiTarget, Call, OpencodeApi } from "../src/shared/opencode-api.ts"
import type { Timers } from "../src/events/timers.ts"

export type Payload = { type: string; properties: Record<string, unknown> }

type Sink = ReadableStreamDefaultController<Uint8Array>

const enc = new TextEncoder()
const PASSWORD = "fake-password-for-tests-1"
const AUTH = "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64")

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

export class FakeBox {
  readonly target: ApiTarget = { baseUrl: "", password: PASSWORD }
  /** directory → sessionID → status (absent = idle, as the real server does). */
  readonly status = new Map<string, Record<string, { type: string; attempt?: number }>>()
  readonly sessions = new Map<string, { id: string; directory: string; parentID?: string }>()
  /** Paths answered with a redirect (W2C-02). */
  readonly redirects = new Set<string>()
  readonly permissions: Array<{ id: string; sessionID: string; directory: string }> = []
  readonly questions: Array<{ id: string; sessionID: string; directory: string }> = []
  readonly requests: string[] = []
  private readonly clients = new Set<Sink>()
  private connections = 0
  private server: Server<undefined> | undefined
  private port = 0

  connects(): number {
    return this.connections
  }

  send(payload: Payload, directory = "/sessions/a"): void {
    this.raw(`data: ${JSON.stringify({ directory, payload: { id: "evt_1", ...payload } })}\n\n`)
  }

  raw(text: string): void {
    for (const c of [...this.clients]) {
      try {
        c.enqueue(enc.encode(text))
      } catch {
        this.clients.delete(c) // the client went away
      }
    }
  }

  dropStreams(): void {
    for (const c of this.clients) {
      try {
        c.close()
      } catch {
        // already cancelled by the client
      }
    }
    this.clients.clear()
  }

  async down(): Promise<void> {
    this.dropStreams()
    await this.server?.stop(true)
    this.server = undefined
  }

  async up(): Promise<void> {
    this.server = Bun.serve({ port: this.port, hostname: "127.0.0.1", idleTimeout: 0, fetch: (req) => this.handle(req) })
    this.port = this.server.port ?? this.port
    this.target.baseUrl = `http://127.0.0.1:${this.port}`
  }

  stop(): Promise<void> {
    return this.down()
  }

  private stream(): Response {
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.connections++
        this.clients.add(c)
        c.enqueue(enc.encode(`data: ${JSON.stringify({ payload: { id: "evt_0", type: "server.connected", properties: {} } })}\n\n`))
      },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }

  private handle(req: Request): Response {
    if (req.headers.get("authorization") !== AUTH) return new Response("no", { status: 401 })
    const url = new URL(req.url)
    const dir = url.searchParams.get("directory") ?? ""
    this.requests.push(`${req.method} ${url.pathname}${dir ? `?${dir}` : ""}`)
    if (this.redirects.has(url.pathname)) return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } })
    if (url.pathname === "/global/event") return this.stream()
    const children = /^\/session\/([^/]+)\/children$/.exec(url.pathname)
    if (children?.[1]) return json([...this.sessions.values()].filter((s) => s.parentID === decodeURIComponent(children[1] ?? "")))
    if (url.pathname === "/session/status") return json(this.status.get(dir) ?? {})
    if (url.pathname === "/permission") return json(this.permissions.filter((p) => p.directory === dir))
    if (url.pathname === "/question") return json(this.questions.filter((p) => p.directory === dir))
    const m = /^\/session\/([^/]+)$/.exec(url.pathname)
    if (!m?.[1]) return json({}, 404)
    const s = this.sessions.get(decodeURIComponent(m[1]))
    return s ? json(s) : json({ name: "NotFoundError" }, 404)
  }
}

export function startFakeBox(): FakeBox {
  const box = new FakeBox()
  void box.up()
  return box
}

/** Poll until `check` holds (real timers; each poll holds a timer). */
export async function until(check: () => boolean, ms = 3000, what = "condition"): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

export type Route = { status: number; data?: unknown } | Error
export type FakeApi = OpencodeApi & { calls: string[] }

/** Routes keyed `path` or `path?directory`; unknown routes answer 404. An Error value is thrown. */
export function fakeApi(routes: Record<string, Route>): FakeApi {
  const calls: string[] = []
  return {
    calls,
    async call<T>(input: Call) {
      const key = input.directory ? `${input.path}?${input.directory}` : input.path
      calls.push(key)
      const route = routes[key] ?? routes[input.path] ?? { status: 404 }
      if (route instanceof Error) throw route
      return { status: route.status, data: route.data as T | undefined }
    },
  }
}

/**
 * An SSE fetch for manual-timer hub tests: each call opens a stream the test writes to. The body
 * holds a real interval while open (an abort-only body spins a core on Bun/Windows).
 */
export type FakeStream = { fetch: typeof fetch; send(payload: Payload, directory?: string): void; raw(text: string): void; drop(): void; opens(): number }

export function fakeStream(): FakeStream {
  const sinks = new Map<Sink, ReturnType<typeof setInterval>>()
  let opens = 0
  const open = (): Response => {
    let sink: Sink | undefined
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        opens++
        sink = c
        sinks.set(c, setInterval(() => {}, 1000))
      },
      cancel() {
        if (sink) clearInterval(sinks.get(sink))
        if (sink) sinks.delete(sink)
      },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }
  const write = (text: string) => {
    for (const c of [...sinks.keys()]) {
      try {
        c.enqueue(enc.encode(text))
      } catch {
        clearInterval(sinks.get(c))
        sinks.delete(c)
      }
    }
  }
  return {
    fetch: (async () => open()) as unknown as typeof fetch,
    send: (payload, directory = "/sessions/a") => write(`data: ${JSON.stringify({ directory, payload: { id: "evt_1", ...payload } })}\n\n`),
    raw: write,
    drop() {
      for (const [c, keepAlive] of sinks) {
        clearInterval(keepAlive)
        try {
          c.close()
        } catch {
          // already cancelled
        }
      }
      sinks.clear()
    },
    opens: () => opens,
  }
}

export type ManualTimers ={ timers: Timers; advance(ms: number): void; pending(): number; delays: number[] }

export function manualTimers(start = 1_000_000): ManualTimers {
  let now = start
  type Task = { at: number; fn: () => void }
  let tasks: Task[] = []
  const delays: number[] = []
  const timers: Timers = {
    now: () => now,
    setTimeout(fn, ms) {
      const task = { at: now + ms, fn }
      delays.push(ms)
      tasks.push(task)
      return () => {
        tasks = tasks.filter((t) => t !== task)
      }
    },
  }
  return {
    timers,
    delays,
    pending: () => tasks.length,
    advance(ms) {
      const end = now + ms
      for (;;) {
        const due = tasks.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        tasks = tasks.filter((t) => t !== due)
        now = due.at
        due.fn()
      }
      now = end
    },
  }
}
