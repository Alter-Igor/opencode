import { describe, expect, test } from "bun:test"
import {
  PINNED_FALLBACK_ENV,
  PinnedFallbackMemory,
  classifyModelUnusable,
  mcpToolErrorText,
  pinnedFallbackEnabled,
  pinnedModelFallback,
} from "../../src/plugin/synapse-fallback"
import { SYNAPSE_MCP_FALLBACK_MODEL, SynapseAuthPlugin, setLatestSynapseServing } from "../../src/plugin/synapse"
import { sessionObserver } from "../../src/plugin/observer"

// #80: a pinned Synapse model that cannot serve the request is retried ONCE with `auto`.

const BASE = "https://synapse.example.test/v1"
const API_KEY = "sk-test-pinned-fallback-0123456789abcdef"

const errorReply = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const okReply = (servedModel = "qwen/qwen3.8-flash") =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
    status: 200,
    headers: { "content-type": "application/json", "x-synapse-served-model": servedModel },
  })

describe("classifyModelUnusable (#80)", () => {
  test("credit, tool support, model unavailable and rate limit are model-unusable", () => {
    expect(classifyModelUnusable(402, "")).toBe("budget")
    expect(classifyModelUnusable(400, '{"error":{"code":"budget_exhausted"}}')).toBe("budget")
    expect(classifyModelUnusable(403, "insufficient credit")).toBeUndefined()
    expect(classifyModelUnusable(400, "No endpoints found that support tool use")).toBe("no-tool-support")
    expect(classifyModelUnusable(422, '{"error":{"code":"unmet_capability","capability":"tools"}}')).toBe("no-tool-support")
    expect(classifyModelUnusable(400, '{"error":{"code":"insufficient_quota"}}')).toBe("budget")
    expect(classifyModelUnusable(503, "model is unavailable: insufficient credit")).toBe("budget")
    expect(classifyModelUnusable(404, "No endpoints found for claude-opus-5")).toBe("model-unavailable")
    expect(classifyModelUnusable(404, "The model claude-opus-5 was not found")).toBe("model-unavailable")
    expect(classifyModelUnusable(400, '{"error":{"code":"model_not_found"}}')).toBe("model-unavailable")
    expect(classifyModelUnusable(429, "")).toBe("rate-limited")
    expect(classifyModelUnusable(503, '{"error":{"code":"rate_limited"}}')).toBe("rate-limited")
  })

  test("auth, context and validation errors are not model-unusable", () => {
    expect(classifyModelUnusable(401, "budget_exhausted")).toBeUndefined()
    expect(classifyModelUnusable(403, "rate_limited")).toBeUndefined()
    expect(classifyModelUnusable(400, '{"error":{"code":"context_length_exceeded","message":"insufficient context"}}')).toBeUndefined()
    expect(classifyModelUnusable(400, '{"error":{"message":"messages: required"}}')).toBeUndefined()
    expect(classifyModelUnusable(500, "internal error")).toBeUndefined()
  })

  test("credit words without a 402, a budget code or availability wording, and a route 404, do not fall back", () => {
    expect(classifyModelUnusable(400, '{"error":{"message":"insufficient arguments for tool call"}}')).toBeUndefined()
    expect(classifyModelUnusable(400, "credit card field is invalid")).toBeUndefined()
    expect(classifyModelUnusable(500, "balance check failed")).toBeUndefined()
    expect(classifyModelUnusable(404, "")).toBeUndefined()
    expect(classifyModelUnusable(404, "Cannot POST /v1/chat/completionz")).toBeUndefined()
    expect(classifyModelUnusable(404, '{"error":"Not Found"}')).toBeUndefined()
  })
})

describe("PinnedFallbackMemory (#80)", () => {
  test("a failed model is marked per session and model, and the mark expires after the TTL", () => {
    let now = 1_000
    const memory = new PinnedFallbackMemory({ ttlMs: 600_000, now: () => now })
    memory.markFailed("ses_a", "claude-opus-5")
    expect(memory.isFailed("ses_a", "claude-opus-5")).toBe(true)
    expect(memory.isFailed("ses_b", "claude-opus-5")).toBe(false)
    expect(memory.isFailed("ses_a", "qwen/qwen3.8-flash")).toBe(false)
    now += 600_001
    expect(memory.isFailed("ses_a", "claude-opus-5")).toBe(false)
    expect(memory.shouldReport("ses_a", "claude-opus-5")).toBe(true)
    expect(memory.shouldReport("ses_a", "claude-opus-5")).toBe(false)
    expect(memory.shouldReport("ses_b", "claude-opus-5")).toBe(true)
  })
})

describe("mcpToolErrorText (#80)", () => {
  test("only a tool error is returned; reply words never are", () => {
    expect(mcpToolErrorText('data: {"result":{"structuredContent":{"content":"payment balance exceeded"}}}')).toBeUndefined()
    expect(mcpToolErrorText('{"result":{"isError":true,"content":[{"type":"text","text":"budget_exhausted"}]}}')).toBe("budget_exhausted")
  })
})

describe("pinnedFallbackEnabled (#80)", () => {
  test("on by default; OPENCODE_SYNAPSE_PINNED_FALLBACK=0 turns it off", () => {
    expect(pinnedFallbackEnabled({})).toBe(true)
    expect(pinnedFallbackEnabled({ [PINNED_FALLBACK_ENV]: "1" })).toBe(true)
    expect(pinnedFallbackEnabled({ [PINNED_FALLBACK_ENV]: "0" })).toBe(false)
    expect(pinnedFallbackEnabled({ [PINNED_FALLBACK_ENV]: "false" })).toBe(false)
  })
})

describe("pinnedModelFallback (#80)", () => {
  const body = JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }], tools: [] })

  test("a pinned model with a budget error is resent once with auto, and the auto reply is returned", async () => {
    const sent: string[] = []
    const result = await pinnedModelFallback({
      model: "claude-opus-5",
      body,
      headers: new Headers(),
      enabled: true,
      response: errorReply(402, { error: { code: "budget_exhausted" } }),
      resend: async (b) => {
        sent.push(b)
        return okReply()
      },
    })
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]).model).toBe("auto")
    expect(JSON.parse(sent[0]).messages).toEqual([{ role: "user", content: "hi" }])
    expect(result.response.status).toBe(200)
    expect(result.event).toEqual({
      originalModel: "claude-opus-5",
      reason: "budget",
      status: 402,
      fallbackModel: "auto",
      fallbackStatus: 200,
      servedModel: "qwen/qwen3.8-flash",
      localOnly: false,
    })
  })

  test("auto failing is not retried again, and an opt-out or a non-matching error makes no resend", async () => {
    let calls = 0
    const resend = async () => {
      calls++
      return okReply()
    }
    const base = { body, headers: new Headers(), resend }
    const auto = await pinnedModelFallback({ ...base, model: "auto", enabled: true, response: errorReply(429, "") })
    expect(auto.event).toBeUndefined()
    expect(auto.response.status).toBe(429)
    expect((await pinnedModelFallback({ ...base, model: "claude-opus-5", enabled: false, response: errorReply(429, "") })).event).toBeUndefined()
    expect((await pinnedModelFallback({ ...base, model: "claude-opus-5", enabled: true, response: errorReply(401, "") })).event).toBeUndefined()
    expect((await pinnedModelFallback({ ...base, model: "claude-opus-5", enabled: true, response: okReply() })).event).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("the fallback failing too returns the fallback reply, with no second resend", async () => {
    let calls = 0
    const result = await pinnedModelFallback({
      model: "claude-opus-5",
      body,
      headers: new Headers(),
      enabled: true,
      response: errorReply(429, ""),
      resend: async () => {
        calls++
        return errorReply(429, "")
      },
    })
    expect(calls).toBe(1)
    expect(result.response.status).toBe(429)
    expect(result.event?.fallbackStatus).toBe(429)
  })
})

describe("Synapse REST path fallback (#80)", () => {
  type Seen = { body: Record<string, any>; headers: Headers }

  async function run(opts: { model: string; first: () => Response; env?: string; headers?: Record<string, string> }) {
    const previousFetch = globalThis.fetch
    const previousEnv = process.env[PINNED_FALLBACK_ENV]
    if (opts.env === undefined) delete process.env[PINNED_FALLBACK_ENV]
    else process.env[PINNED_FALLBACK_ENV] = opts.env
    const seen: Seen[] = []
    const notices: string[] = []
    const stub = async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
      if (!href.endsWith("/chat/completions")) return previousFetch(url, init)
      seen.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) })
      return seen.length === 1 ? opts.first() : okReply("qwen/qwen3.8-flash")
    }
    globalThis.fetch = Object.assign(stub, { preconnect: previousFetch.preconnect })
    try {
      const hooks = await SynapseAuthPlugin(
        {
          client: { tui: { showToast: async (o: any) => notices.push(o?.body?.message ?? "") } } as never,
          project: {} as never,
          directory: "",
          worktree: "",
          experimental_workspace: { register() {} },
          serverUrl: new URL("https://example.com"),
          $: {} as never,
        },
        { inferenceUrl: BASE },
      )
      const stored = { type: "api", key: API_KEY }
      const loaded = await hooks.auth?.loader?.(async () => stored as never, {} as never)
      const chatFetch = loaded?.fetch as (u: string, i: RequestInit) => Promise<Response>
      const response = await chatFetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        body: JSON.stringify({ model: opts.model, messages: [{ role: "user", content: "secret prompt text" }] }),
      })
      return { response, seen, notices }
    } finally {
      // Module-wide telemetry: do not leak this test's served model into other tests.
      setLatestSynapseServing(undefined)
      globalThis.fetch = previousFetch
      if (previousEnv === undefined) delete process.env[PINNED_FALLBACK_ENV]
      else process.env[PINNED_FALLBACK_ENV] = previousEnv
    }
  }

  const fallbackLogs = () => sessionObserver.getDiagnosticLogs().filter((e) => e.type === "FALLBACK_TRIGGERED" && e.details?.reason)

  test("a pinned model with 429 is resent with auto; the diagnostic names model, reason, status and served model, with no token or prompt", async () => {
    const before = fallbackLogs().length
    const { response, seen, notices } = await run({ model: "qwen/qwen3.8-flash", first: () => errorReply(429, { error: { code: "rate_limited" } }) })
    expect(seen.map((s) => s.body.model)).toEqual(["qwen/qwen3.8-flash", "auto"])
    expect(response.status).toBe(200)
    const logs = fallbackLogs()
    expect(logs.length).toBe(before + 1)
    expect(logs[0].details).toMatchObject({
      originalModel: "qwen/qwen3.8-flash",
      reason: "rate-limited",
      status: 429,
      fallbackModel: "auto",
      servedModel: "qwen/qwen3.8-flash",
    })
    const logged = JSON.stringify(logs[0])
    expect(logged).not.toContain(API_KEY)
    expect(logged).not.toContain("secret prompt text")
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("qwen/qwen3.8-flash")
    expect(notices[0]).toContain("auto")
    expect(notices[0]).not.toContain(API_KEY)
  })

  test("401 makes no fallback", async () => {
    const { response, seen } = await run({ model: "claude-opus-5", first: () => errorReply(401, { error: "unauthorized" }) })
    expect(seen).toHaveLength(1)
    expect(response.status).toBe(401)
  })

  test("auto failing makes no second request", async () => {
    const { response, seen } = await run({ model: "auto", first: () => errorReply(402, { error: { code: "budget_exhausted" } }) })
    expect(seen).toHaveLength(1)
    expect(response.status).toBe(402)
  })

  test("OPENCODE_SYNAPSE_PINNED_FALLBACK=0 turns the fallback off", async () => {
    const { response, seen } = await run({ model: "claude-opus-5", env: "0", first: () => errorReply(402, "") })
    expect(seen).toHaveLength(1)
    expect(response.status).toBe(402)
  })

  test("a local-only request keeps x-privacy-tier: local-only on the auto resend", async () => {
    const { seen } = await run({
      model: "claude-opus-5",
      headers: { "x-privacy-tier": "local-only" },
      first: () => errorReply(404, { error: { code: "model_not_found" } }),
    })
    expect(seen).toHaveLength(2)
    expect(seen[1].body.model).toBe("auto")
    expect(seen[1].headers.get("x-privacy-tier")).toBe("local-only")
    expect(fallbackLogs()[0].details).toMatchObject({ reason: "model-unavailable", localOnly: true })
  })
})

describe("Synapse MCP bridge fallback (#80)", () => {
  test("the MCP path's fallback model is auto, still local-only", async () => {
    expect(SYNAPSE_MCP_FALLBACK_MODEL).toBe("auto")
    const previousFetch = globalThis.fetch
    const calls: Record<string, any>[] = []
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
    const payload = Buffer.from(
      JSON.stringify({ aud: "https://synapse-mcp.alterspective.com.au/mcp", exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url")
    const jwt = `${header}.${payload}.sig`
    const stub = async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
      if (!href.startsWith("https://synapse-mcp.alterspective.com.au/mcp")) return previousFetch(url, init)
      calls.push(JSON.parse(String(init?.body)).params.arguments)
      if (calls.length === 1) return new Response("payment required", { status: 402 })
      return new Response(
        JSON.stringify({ result: { structuredContent: { content: "hello", servedModel: "qwen/qwen3.8-flash" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    globalThis.fetch = Object.assign(stub, { preconnect: previousFetch.preconnect })
    try {
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
        { inferenceUrl: BASE },
      )
      const stored = { type: "api", key: jwt, metadata: { expiresAt: String(Date.now() + 3_600_000) } }
      const loaded = await hooks.auth?.loader?.(async () => stored as never, {} as never)
      const chatFetch = loaded?.fetch as (u: string, i: RequestInit) => Promise<Response>
      const response = await chatFetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] }),
      })
      expect(response.status).toBe(200)
      expect(calls).toHaveLength(2)
      expect(calls[0].model).toBe("claude-opus-5")
      expect(calls[1].model).toBe("auto")
      expect(calls[1].privacyTier).toBe("local-only")
    } finally {
      // Module-wide telemetry: do not leak this test's served model into other tests.
      setLatestSynapseServing(undefined)
      globalThis.fetch = previousFetch
    }
  })
})

type Step = { url: string; body: Record<string, any>; headers: Headers }

/** One plugin instance over several steps, with a stubbed fetch and an injectable fallback memory. */
async function harness(opts: {
  reply: (step: Step, n: number) => Response
  memory?: PinnedFallbackMemory
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
    const step = { url: href, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) }
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
    { inferenceUrl: BASE, fallbackMemory: opts.memory, notify: (m) => notices.push(m) },
  )
  const token = opts.token ?? API_KEY
  const stored = { type: "api", key: token, metadata: { expiresAt: String(Date.now() + 3_600_000) } }
  const loaded = await hooks.auth?.loader?.(async () => stored as never, {} as never)
  const chatFetch = loaded?.fetch as (u: string, i: RequestInit) => Promise<Response>
  const chat = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    chatFetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-session": "ses_fallback", ...headers },
      body: JSON.stringify(body),
    })
  const restore = () => {
    setLatestSynapseServing(undefined)
    globalThis.fetch = previousFetch
    if (previousEnv === undefined) delete process.env[PINNED_FALLBACK_ENV]
    else process.env[PINNED_FALLBACK_ENV] = previousEnv
  }
  return { chat, seen, notices, restore }
}

const messages = [{ role: "user", content: "hi" }]
const fallbackCount = () =>
  sessionObserver.getDiagnosticLogs().filter((e) => e.type === "FALLBACK_TRIGGERED" && e.details?.reason).length

describe("failed pinned models are remembered per session (#80)", () => {
  test("a second step skips the failed model, it is retried after the TTL, and there is one toast and one log", async () => {
    let now = 5_000
    const memory = new PinnedFallbackMemory({ ttlMs: 600_000, now: () => now })
    const h = await harness({
      memory,
      reply: (step) => (step.body.model === "auto" ? okReply() : errorReply(429, { error: { code: "rate_limited" } })),
    })
    try {
      const logsBefore = fallbackCount()
      expect((await h.chat({ model: "claude-opus-5", messages })).status).toBe(200)
      expect(h.seen.map((s) => s.body.model)).toEqual(["claude-opus-5", "auto"])
      expect((await h.chat({ model: "claude-opus-5", messages })).status).toBe(200)
      expect(h.seen.map((s) => s.body.model)).toEqual(["claude-opus-5", "auto", "auto"])
      now += 600_001
      expect((await h.chat({ model: "claude-opus-5", messages })).status).toBe(200)
      expect(h.seen.map((s) => s.body.model)).toEqual(["claude-opus-5", "auto", "auto", "claude-opus-5", "auto"])
      expect(h.notices).toHaveLength(1)
      expect(fallbackCount()).toBe(logsBefore + 1)
    } finally {
      h.restore()
    }
  })

  test("another session still tries the pinned model first", async () => {
    const h = await harness({
      memory: new PinnedFallbackMemory(),
      reply: (step) => (step.body.model === "auto" ? okReply() : errorReply(402, "")),
    })
    try {
      await h.chat({ model: "claude-opus-5", messages })
      await h.chat({ model: "claude-opus-5", messages }, { "x-opencode-session": "ses_other" })
      expect(h.seen.map((s) => s.body.model)).toEqual(["claude-opus-5", "auto", "claude-opus-5", "auto"])
      expect(h.notices).toHaveLength(2)
    } finally {
      h.restore()
    }
  })
})

describe("REST fallback keeps the request intact (#80)", () => {
  test("a streaming request falls back to a streaming auto reply; stream, tools and temperature are resent unchanged", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
    const h = await harness({
      memory: new PinnedFallbackMemory(),
      reply: (step) =>
        step.body.model === "auto"
          ? new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream", "x-synapse-served-model": "qwen/qwen3.8-flash" },
            })
          : errorReply(402, { error: { code: "budget_exhausted" } }),
    })
    try {
      const tools = [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } }]
      const body = { model: "claude-opus-5", messages, stream: true, tools, temperature: 0.2, max_tokens: 64 }
      const response = await h.chat(body)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      expect(await response.text()).toBe(sse)
      expect(h.seen).toHaveLength(2)
      const { model: first, ...firstRest } = h.seen[0].body
      const { model: second, ...secondRest } = h.seen[1].body
      expect([first, second]).toEqual(["claude-opus-5", "auto"])
      expect(secondRest).toEqual(firstRest)
      expect(secondRest).toMatchObject({ stream: true, tools, temperature: 0.2, max_tokens: 64 })
    } finally {
      h.restore()
    }
  })

  test("when auto fails too, both errors are logged, each under its own model", async () => {
    const h = await harness({
      memory: new PinnedFallbackMemory(),
      reply: (step) =>
        step.body.model === "auto"
          ? errorReply(429, { error: { code: "rate_limited", message: "auto busy" } })
          : errorReply(402, { error: { code: "budget_exhausted" } }),
    })
    try {
      const response = await h.chat({ model: "claude-opus-5", messages })
      expect(response.status).toBe(429)
      const errors = sessionObserver
        .getDiagnosticLogs()
        .filter((e) => e.type === "INFERENCE_ERROR")
        .slice(0, 2)
      expect(errors.map((e) => [e.details?.model, e.details?.status])).toEqual([
        ["auto", 429],
        ["claude-opus-5", 402],
      ])
      expect(h.seen).toHaveLength(2)
    } finally {
      h.restore()
    }
  })
})

describe("Synapse MCP bridge trigger (#80)", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({ aud: "https://synapse-mcp.alterspective.com.au/mcp", exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url")
  const jwt = `${header}.${payload}.sig`
  const isMcp = (s: Step) => s.url.startsWith("https://synapse-mcp.alterspective.com.au/mcp")
  const mcpModels = (seen: Step[]) => seen.filter(isMcp).map((s) => s.body.params.arguments.model ?? "(none)")
  const mcpOk = (content: string) =>
    new Response(JSON.stringify({ result: { structuredContent: { content, servedModel: "qwen/qwen3.8-flash" } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })

  test("a 200 reply that mentions payment, balance or exceeded is not a failure", async () => {
    const h = await harness({
      token: jwt,
      memory: new PinnedFallbackMemory(),
      reply: () => mcpOk("the payment balance was exceeded last month"),
    })
    try {
      expect((await h.chat({ model: "claude-opus-5", messages })).status).toBe(200)
      expect(mcpModels(h.seen)).toEqual(["claude-opus-5"])
      expect(h.notices).toHaveLength(0)
    } finally {
      h.restore()
    }
  })

  test("401 and an auto request make no MCP fallback", async () => {
    const h = await harness({
      token: jwt,
      memory: new PinnedFallbackMemory(),
      reply: (step) =>
        isMcp(step)
          ? new Response("unauthorized", { status: step.body.params.arguments.model ? 401 : 402 })
          : okReply(),
    })
    try {
      await h.chat({ model: "claude-opus-5", messages })
      await h.chat({ model: "auto", messages })
      expect(mcpModels(h.seen)).toEqual(["claude-opus-5", "(none)"])
      expect(h.notices).toHaveLength(0)
    } finally {
      h.restore()
    }
  })

  test("a budget failure falls back to auto once, is remembered, and is shown once", async () => {
    const h = await harness({
      token: jwt,
      memory: new PinnedFallbackMemory(),
      reply: (step) =>
        step.body.params.arguments.model === "auto" ? mcpOk("hello") : new Response("payment required", { status: 402 }),
    })
    try {
      expect((await h.chat({ model: "claude-opus-5", messages })).status).toBe(200)
      expect((await h.chat({ model: "claude-opus-5", messages })).status).toBe(200)
      expect(mcpModels(h.seen)).toEqual(["claude-opus-5", "auto", "auto"])
      const autoCalls = h.seen.filter(isMcp).filter((s) => s.body.params.arguments.model === "auto")
      expect(autoCalls.every((s) => s.body.params.arguments.privacyTier === "local-only")).toBe(true)
      expect(h.notices).toHaveLength(1)
    } finally {
      h.restore()
    }
  })
})
