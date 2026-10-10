import { describe, expect, test } from "bun:test"
import {
  CORRELATION_ID_HEADER,
  CORRELATION_CLIENT_PREFIX,
  CORRELATION_ID_MAX_LENGTH,
  createCorrelationId,
  SynapseAuthPlugin,
  setLatestSynapseServing,
  getLatestSynapseServing,
} from "../../src/plugin/synapse"

// #151: every outbound Synapse request propagates X-Correlation-Id following
// Alterspective standard WEBSTA-001-OBSERVABILITY-STANDARDS OBS-ID-01..06.

const BASE = "https://synapse-corr.example.test/v1"
const API_KEY = "sk-test-correlation-id-key"
const MCP = "https://synapse-mcp.alterspective.com.au/mcp"

const pluginInput = {
  client: {} as never,
  project: {} as never,
  directory: "/test/dir",
  worktree: "",
  experimental_workspace: { register() {} },
  serverUrl: new URL("https://example.com"),
  $: {} as never,
}

type Call = { href: string; headers: Headers; body?: any }

async function capture(fn: () => Promise<void>): Promise<Call[]> {
  const previousFetch = globalThis.fetch
  const calls: Call[] = []
  const stub = async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    if (!href.startsWith(BASE) && !href.startsWith(MCP)) return previousFetch(url, init)
    calls.push({ href, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
      headers: {
        "content-type": "application/json",
        "x-synapse-served-model": "qwen3.8-27b-dflash2",
        "x-correlation-id": new Headers(init?.headers).get("x-correlation-id") || "echoed-corr-id",
      },
    })
  }
  globalThis.fetch = Object.assign(stub, { preconnect: previousFetch.preconnect })
  try {
    await fn()
    return calls
  } finally {
    setLatestSynapseServing(undefined)
    globalThis.fetch = previousFetch
  }
}

describe("createCorrelationId (#151)", () => {
  test("generates prefixed correlation ID in opencode:<unit>:<entropy> shape", () => {
    const id = createCorrelationId("ses_test123")
    expect(id.startsWith("opencode:ses_test123:")).toBe(true)
    expect(id.length).toBeLessThanOrEqual(CORRELATION_ID_MAX_LENGTH)
  })

  test("sanitizes unsafe characters in session key", () => {
    const id = createCorrelationId("path/to/my session!")
    expect(id.startsWith("opencode:path_to_my_session_:")).toBe(true)
  })

  test("falls back to global when session key is omitted", () => {
    const id = createCorrelationId()
    expect(id.startsWith("opencode:global:")).toBe(true)
  })

  test("never exceeds CORRELATION_ID_MAX_LENGTH even with huge session keys", () => {
    const hugeKey = "a".repeat(500)
    const id = createCorrelationId(hugeKey)
    expect(id.length).toBeLessThanOrEqual(CORRELATION_ID_MAX_LENGTH)
    expect(id.startsWith("opencode:")).toBe(true)
  })
})

describe("chat.headers hook (#151)", () => {
  test("injects X-Correlation-Id matching opencode:<sessionID>:* into headers", async () => {
    const hooks = await SynapseAuthPlugin(pluginInput)
    const output = { headers: {} as Record<string, string> }
    await hooks["chat.headers"]?.({ sessionID: "ses_abc" } as never, output)
    expect(output.headers[CORRELATION_ID_HEADER]).toBeDefined()
    expect(output.headers[CORRELATION_ID_HEADER].startsWith("opencode:ses_abc:")).toBe(true)
  })

  test("preserves existing correlation ID if caller already provided one", async () => {
    const hooks = await SynapseAuthPlugin(pluginInput)
    const output = { headers: { [CORRELATION_ID_HEADER]: "custom:corr:123" } }
    await hooks["chat.headers"]?.({ sessionID: "ses_abc" } as never, output)
    expect(output.headers[CORRELATION_ID_HEADER]).toBe("custom:corr:123")
  })
})

describe("Synapse provider fetch correlation ID (#151)", () => {
  test("attaches X-Correlation-Id to outbound REST request and records in telemetry", async () => {
      let capturedTelemetry: ReturnType<typeof getLatestSynapseServing>
      const calls = await capture(async () => {
        const hooks = await SynapseAuthPlugin(pluginInput)
        const authResult = await (hooks.auth as any)?.loader(async () => ({
          type: "api",
          key: API_KEY,
        }))
        await authResult.fetch(`${BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-session": "ses_xyz",
          },
          body: JSON.stringify({ model: "synapse/auto", messages: [{ role: "user", content: "hi" }] }),
        })
        capturedTelemetry = getLatestSynapseServing()
      })

      expect(calls.length).toBe(1)
      const corrHeader = calls[0].headers.get(CORRELATION_ID_HEADER)
      expect(corrHeader).toBeDefined()
      expect(corrHeader?.startsWith("opencode:ses_xyz:")).toBe(true)
      expect(capturedTelemetry?.correlationId).toBe(corrHeader!)
    })

    test("attaches X-Correlation-Id to outbound MCP bridge request", async () => {
      // Legacy Keystone JWT token targeting MCP resource URI routes via MCP bridge
      const jwtToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJodHRwczovL3N5bmFwc2UtbWNwLmFsdGVyc3BlY3RpdmUuY29tLmF1L21jcCJ9.fake"
      let capturedTelemetry: ReturnType<typeof getLatestSynapseServing>
      const calls = await capture(async () => {
        const hooks = await SynapseAuthPlugin(pluginInput)
        const authResult = await (hooks.auth as any)?.loader(async () => ({
          type: "oauth",
          access: jwtToken,
        }))
        await authResult.fetch(`${BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-session": "ses_mcp_bridge",
          },
          body: JSON.stringify({ model: "synapse/auto", messages: [{ role: "user", content: "hi" }] }),
        })
        capturedTelemetry = getLatestSynapseServing()
      })

      expect(calls.length).toBe(1)
      expect(calls[0].href).toBe(MCP)
      const corrHeader = calls[0].headers.get(CORRELATION_ID_HEADER)
      expect(corrHeader).toBeDefined()
      expect(corrHeader?.startsWith("opencode:ses_mcp_bridge:")).toBe(true)
      expect(capturedTelemetry?.correlationId).toBe(corrHeader!)
    })
  })
