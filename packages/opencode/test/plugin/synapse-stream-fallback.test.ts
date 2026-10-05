import { describe, expect, test } from "bun:test"
import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"
import { PINNED_FALLBACK_ENV, PinnedFallbackMemory, SSE_PEEK_MAX_BYTES, peekSseError, pinnedFallbackNotice } from "../../src/plugin/synapse-fallback"
import { SynapseAuthPlugin, setLatestSynapseServing } from "../../src/plugin/synapse"
import { diagnosticsLogDir, sessionObserver } from "../../src/plugin/observer"

// #80 follow-up: with stream:true (what OpenCode always sends) Synapse answers HTTP 200
// text/event-stream and puts the failure in the FIRST event. The plugin peeks at that event.

const BASE = "https://synapse.example.test/v1"
const API_KEY = "sk-test-stream-fallback-0123456789abcdef"
const encoder = new TextEncoder()

// Observed live on 2026-10-03 (google/gemini-3.1-flash-image, with tools, stream:true).
const TOOL_ERROR_EVENT =
  'event: error\ndata: {"error":{"message":"All 1 provider rung(s) returned no usable output: No endpoints found that support tool use.","type":"server_error","code":"all_providers_failed"}}\n\n'
const OK_SSE = 'data: {"choices":[{"delta":{"content":"héllo"}}]}\n\ndata: [DONE]\n\n'

/** A text/event-stream response that sends `chunks` (strings or bytes), each after `delayMs`. */
function sse(
  chunks: Array<string | Uint8Array>,
  opts: { delayMs?: number; onCancel?: () => void; status?: number; hang?: boolean } = {},
): Response {
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      if (i >= chunks.length) return opts.hang ? new Promise<void>(() => {}) : controller.close()
      const chunk = chunks[i++]
      controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
    },
    cancel() {
      opts.onCancel?.()
    },
  })
  return new Response(body, {
    status: opts.status ?? 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "x-synapse-served-model": "qwen/qwen3.8-flash" },
  })
}

/** A stream that sends nothing until it is cancelled. */
function silentSse(onCancel: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    pull: () => new Promise(() => {}),
    cancel: onCancel,
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

type Step = { body: Record<string, any> }

async function harness(opts: {
  reply: (step: Step, n: number) => Response
  memory?: PinnedFallbackMemory
  ssePeek?: { maxBytes?: number; timeoutMs?: number }
  token?: string
}) {
  const previousFetch = globalThis.fetch
  const previousEnv = process.env[PINNED_FALLBACK_ENV]
  delete process.env[PINNED_FALLBACK_ENV]
  const seen: Step[] = []
  const notices: string[] = []
  const stub = async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    if (!href.endsWith("/chat/completions") && !href.startsWith("https://synapse-mcp.alterspective.com.au/mcp")) {
      return previousFetch(url, init)
    }
    const parsed = JSON.parse(String(init?.body))
    const step = { body: parsed.params?.arguments ?? parsed }
    seen.push(step)
    return opts.reply(step, seen.length)
  }
  globalThis.fetch = Object.assign(stub, { preconnect: previousFetch.preconnect })
  const hooks = await SynapseAuthPlugin(
    {
      client: {} as never,
      project: {} as never,
      directory: "",
      worktree: "",
      experimental_workspace: { register() {} },
      serverUrl: new URL("https://example.com"),
      $: {} as never,
    },
    { inferenceUrl: BASE, fallbackMemory: opts.memory ?? new PinnedFallbackMemory(), notify: (m) => notices.push(m), ssePeek: opts.ssePeek },
  )
  const loaded = await hooks.auth?.loader?.(async () => ({ type: "api", key: opts.token ?? API_KEY, metadata: { expiresAt: String(Date.now() + 3_600_000) } }) as never, {} as never)
  const chatFetch = loaded?.fetch as (u: string, i: RequestInit) => Promise<Response>
  const chat = (model: string, signal?: AbortSignal) =>
    chatFetch(`${BASE}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-opencode-session": "ses_stream" },
      body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }], tools: [] }),
    })
  const restore = () => {
    setLatestSynapseServing(undefined)
    globalThis.fetch = previousFetch
    if (previousEnv === undefined) delete process.env[PINNED_FALLBACK_ENV]
    else process.env[PINNED_FALLBACK_ENV] = previousEnv
  }
  return { chat, seen, notices, restore }
}

const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer())
const concat = (parts: Array<string | Uint8Array>) =>
  new Uint8Array(Buffer.concat(parts.map((p) => (typeof p === "string" ? encoder.encode(p) : p))))

describe("peekSseError (#80 follow-up)", () => {
  test("finds an error in the first event, with its status defaulting to 502", async () => {
    const peek = await peekSseError(sse([TOOL_ERROR_EVENT]))
    expect(peek.error?.status).toBe(502)
    expect(peek.error?.text).toContain("No endpoints found that support tool use")
  })

  test("a data-only first event with a top-level error and a status is an error with that status", async () => {
    const peek = await peekSseError(sse(['data: {"error":{"code":"budget_exhausted","status":402}}\n\n']))
    expect(peek.error?.status).toBe(402)
  })

  test("a normal first event is not an error, and the stream is rebuilt byte for byte", async () => {
    const chunks = ['data: {"cho', 'ices":[{"delta":{"content":"h', encoder.encode("é").slice(0, 1), encoder.encode("é").slice(1), 'llo"}}]}\n', "\ndata: [DONE]\n\n"]
    const peek = await peekSseError(sse(chunks))
    expect(peek.error).toBeUndefined()
    expect(await bytes(peek.response)).toEqual(concat(chunks))
  })
})

describe("peekSseError and the notice (#83)", () => {
  test("a lone retry:, an id: and an event with no data are skipped, then the error is found", async () => {
    const chunks = ["retry: 3000\n\n", "id: 7\n\n", "event: ping\n\n", TOOL_ERROR_EVENT]
    const peek = await peekSseError(sse(chunks))
    expect(peek.error?.text).toContain("No endpoints found that support tool use")
    expect(await bytes(peek.response)).toEqual(concat(chunks))
  })

  test("event: error with no data is still an error", async () => {
    const peek = await peekSseError(sse(["event: error\n\n"]))
    expect(peek.error?.status).toBe(502)
    expect(peek.error?.code).toBeUndefined()
  })

  test("a skipped block does not stretch the bounds: past the byte cap the stream is handed on unread", async () => {
    const pings = "event: ping\n\n".repeat(Math.ceil(SSE_PEEK_MAX_BYTES / 12) + 1)
    const peek = await peekSseError(sse([pings, TOOL_ERROR_EVENT]))
    expect(peek.error).toBeUndefined()
  })

  test("the event's own code is kept; the 502 default is not", async () => {
    expect((await peekSseError(sse(['data: {"error":{"code":"budget_exhausted","status":402}}\n\n']))).error?.code).toBe(402)
    expect((await peekSseError(sse([TOOL_ERROR_EVENT]))).error?.code).toBeUndefined()
  })

  test("the notice names a stream error as such, not as HTTP 502", () => {
    const base = { originalModel: "google/gemini-3.1-flash-image", reason: "no-tool-support" as const, fallbackModel: "auto" as const, fallbackStatus: 200, localOnly: false }
    const noCode = pinnedFallbackNotice({ ...base, status: 502, inStream: true })
    expect(noCode).toContain("error event in an HTTP 200 stream")
    expect(noCode).not.toContain("502")
    expect(pinnedFallbackNotice({ ...base, status: 429, inStream: true, streamCode: 429 })).toContain("error event in an HTTP 200 stream, code 429")
    expect(pinnedFallbackNotice({ ...base, status: 404 })).toContain("(HTTP 404)")
  })
})

describe("REST stream fallback (#80 follow-up)", () => {
  test("a 200 stream whose first event is an error falls back once, and the auto stream is returned", async () => {
    let cancelled = false
    const h = await harness({
      reply: (step) => (step.body.model === "auto" ? sse([OK_SSE]) : sse([TOOL_ERROR_EVENT], { hang: true, onCancel: () => (cancelled = true) })),
    })
    try {
      const response = await h.chat("google/gemini-3.1-flash-image")
      expect(response.status).toBe(200)
      // Bounded: without the fallback the hanging error stream would never end.
      const text = await Promise.race([response.text(), new Promise<string>((r) => setTimeout(() => r("TIMEOUT"), 2000))])
      expect(text).toBe(OK_SSE)
      expect(h.seen.map((s) => s.body.model)).toEqual(["google/gemini-3.1-flash-image", "auto"])
      expect(h.seen[1].body).toMatchObject({ stream: true, tools: [] })
      expect(h.notices).toHaveLength(1)
      expect(h.notices[0]).toContain("cannot use tools")
      expect(cancelled).toBe(true)
    } finally {
      h.restore()
    }
  })

  test("a normal stream passes through byte-identical, even when the first event is split across chunks", async () => {
    const chunks = ["da", 'ta: {"choices":[{"delta":{"content":"h', encoder.encode("é").slice(0, 1), encoder.encode("é").slice(1), 'llo"}}]}\n', "\n", "data: [DONE]\n\n"]
    const h = await harness({ reply: () => sse(chunks, { delayMs: 2 }) })
    try {
      const response = await h.chat("claude-opus-5")
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      expect(response.headers.get("x-synapse-served-model")).toBe("qwen/qwen3.8-flash")
      expect(await bytes(response)).toEqual(concat(chunks))
      expect(h.seen).toHaveLength(1)
      expect(h.notices).toHaveLength(0)
    } finally {
      h.restore()
    }
  })

  test("a first event larger than the peek bound passes through untouched, even an error", async () => {
    const big = "x".repeat(SSE_PEEK_MAX_BYTES + 1024)
    const event = `event: error\ndata: {"error":{"message":"No endpoints found that support tool use ${big}"}}\n\n`
    const parts = [event.slice(0, 30_000), event.slice(30_000, 60_000), event.slice(60_000)]
    const h = await harness({ reply: () => sse(parts) })
    try {
      const response = await h.chat("claude-opus-5")
      expect(await response.text()).toBe(event)
      expect(h.seen).toHaveLength(1)
    } finally {
      h.restore()
    }
  })

  test("a slow first token is not eaten: past the peek deadline the stream passes through", async () => {
    const chunks = ['data: {"choices":[{"delta":{"content":"late"}}]}\n\n', "data: [DONE]\n\n"]
    const h = await harness({ ssePeek: { timeoutMs: 10 }, reply: () => sse(chunks, { delayMs: 60 }) })
    try {
      const response = await h.chat("claude-opus-5")
      expect(await response.text()).toBe(chunks.join(""))
      expect(h.seen).toHaveLength(1)
    } finally {
      h.restore()
    }
  })

  test("aborting during the peek rejects the call and cancels the upstream stream", async () => {
    let cancelled = false
    const h = await harness({ reply: () => silentSse(() => (cancelled = true)) })
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 20)
      const error = await h.chat("claude-opus-5", controller.signal).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect((error as Error | undefined)?.name).toBe("AbortError")
      expect(cancelled).toBe(true)
    } finally {
      h.restore()
    }
  })

  test("a passed-through stream can still be cancelled by the caller", async () => {
    let cancelled = false
    const h = await harness({
      reply: () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
          },
          pull: () => new Promise(() => {}),
          cancel: () => {
            cancelled = true
          },
        })
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      const response = await h.chat("claude-opus-5")
      const reader = response.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      await reader.cancel()
      expect(cancelled).toBe(true)
    } finally {
      h.restore()
    }
  })

  test("memory and toast: the next step goes straight to auto, with one toast", async () => {
    const h = await harness({
      reply: (step) => (step.body.model === "auto" ? sse([OK_SSE]) : sse(['data: {"error":{"code":"budget_exhausted"}}\n\n'])),
    })
    try {
      expect(await (await h.chat("claude-opus-5")).text()).toBe(OK_SSE)
      expect(await (await h.chat("claude-opus-5")).text()).toBe(OK_SSE)
      expect(h.seen.map((s) => s.body.model)).toEqual(["claude-opus-5", "auto", "auto"])
      expect(h.notices).toHaveLength(1)
      expect(h.notices[0]).toContain("out of credit")
    } finally {
      h.restore()
    }
  })

  test("an auto request with an error event is passed through, with no second request", async () => {
    const h = await harness({ reply: () => sse([TOOL_ERROR_EVENT]) })
    try {
      expect(await (await h.chat("auto")).text()).toBe(TOOL_ERROR_EVENT)
      expect(h.seen).toHaveLength(1)
    } finally {
      h.restore()
    }
  })
})

describe("diagnostics log isolation (#80 follow-up)", () => {
  test("under test the diagnostics log goes to the test home, never the real home", async () => {
    const testHome = process.env.OPENCODE_TEST_HOME
    expect(testHome).toBeTruthy()
    const dir = diagnosticsLogDir()
    expect(dir?.startsWith(testHome!)).toBe(true)
    const marker = `isolation-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sessionObserver.logDiagnostic({ timestamp: new Date().toISOString(), type: "AUTH_EVENT", details: { marker } })
    await new Promise((r) => setTimeout(r, 100))
    expect(await fs.readFile(path.join(dir!, "diagnostics.log"), "utf8")).toContain(marker)
    const real = path.join(os.homedir(), ".local", "share", "opencode", "log", "diagnostics.log")
    expect(await fs.readFile(real, "utf8").catch(() => "")).not.toContain(marker)
  })
})

describe("MCP path, error event in a 200 stream (#80 follow-up)", () => {
  test("the MCP path reads the whole reply, so an `event: error` first event already falls back once", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
    const payload = Buffer.from(
      JSON.stringify({ aud: "https://synapse-mcp.alterspective.com.au/mcp", exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url")
    const mcpOk = () =>
      new Response(JSON.stringify({ result: { structuredContent: { content: "hello", servedModel: "qwen/qwen3.8-flash" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    const h = await harness({
      token: `${header}.${payload}.sig`,
      reply: (step) => (step.body.model === "auto" ? mcpOk() : sse([TOOL_ERROR_EVENT])),
    })
    try {
      expect((await h.chat("google/gemini-3.1-flash-image")).status).toBe(200)
      expect(h.seen.map((s) => s.body.model)).toEqual(["google/gemini-3.1-flash-image", "auto"])
      expect(h.notices).toHaveLength(1)
    } finally {
      h.restore()
    }
  })
})
