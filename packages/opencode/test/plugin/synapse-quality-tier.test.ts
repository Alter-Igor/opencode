import { describe, expect, test } from "bun:test"
import { SynapseAuthPlugin, setLatestSynapseServing } from "../../src/plugin/synapse"

// #258: a caller-set x-quality-tier must survive the plugin. A missing or junk
// header falls back to the model's declared tier, or balanced.

const BASE = "https://synapse-quality.example.test/v1"
const API_KEY = "sk-test-quality-tier-0123456789abcdef"

const pluginInput = {
  client: {} as never,
  project: {} as never,
  directory: "",
  worktree: "",
  experimental_workspace: { register() {} },
  serverUrl: new URL("https://example.com"),
  $: {} as never,
}

type Call = { href: string; headers: Headers }

async function capture(model: string, headers?: Record<string, string>): Promise<Call[]> {
  const previousFetch = globalThis.fetch
  const calls: Call[] = []
  const stub = async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    if (!href.startsWith(BASE)) return previousFetch(url, init)
    calls.push({ href, headers: new Headers(init?.headers) })
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] })
  }
  globalThis.fetch = Object.assign(stub, { preconnect: previousFetch.preconnect })
  try {
    const hooks = await SynapseAuthPlugin(pluginInput, { inferenceUrl: BASE })
    const stored = { type: "api", key: API_KEY }
    const loaded = await hooks.auth?.loader?.(async () => stored as never, {} as never)
    const chatFetch = loaded?.fetch as (u: string, i: RequestInit) => Promise<Response>
    const response = await chatFetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(response.status).toBe(200)
    return calls
  } finally {
    setLatestSynapseServing(undefined)
    globalThis.fetch = previousFetch
  }
}

function tier(calls: Call[]): string | null {
  expect(calls).toHaveLength(1)
  return calls[0].headers.get("x-quality-tier")
}

describe("outgoing x-quality-tier (#258)", () => {
  test("a caller premium on auto is sent as premium", async () => {
    const calls = await capture("auto", { "x-quality-tier": "premium" })
    expect(tier(calls)).toBe("premium")
  })

  test("a caller economy wins over a model whose declared tier is premium", async () => {
    const calls = await capture("anthropic/claude-opus-5", { "x-quality-tier": "economy" })
    expect(tier(calls)).toBe("economy")
  })

  test("a missing header on auto is sent as balanced", async () => {
    const calls = await capture("auto")
    expect(tier(calls)).toBe("balanced")
  })

  test("a junk header on auto is sent as balanced", async () => {
    const calls = await capture("auto", { "x-quality-tier": "Premium" })
    expect(tier(calls)).toBe("balanced")
  })

  test("a missing header uses the model's declared tier", async () => {
    const calls = await capture("z-ai/glm-5.3")
    expect(tier(calls)).toBe("economy")
  })
})
