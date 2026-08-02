import { describe, expect, test, beforeAll, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import plugin from "../../../../../.opencode/plugin/cas-bridge-routing"
import {
  MAX_RESPONSE_CHARS,
  casAuthSource,
  casTokenPresent,
  durationMs,
  extractSynapseHeaders,
  formatDuration,
  formatPipelineStatus,
  formatRunInsights,
  formatRunList,
  formatRunTrace,
  formatSynapseProbe,
  looksLikeSecret,
  looksLikeSourceCode,
  parseCasRunListPayload,
  parseCasRunPayload,
  readSelection,
  redactSecrets,
  synapseKeySource,
  validateDelegate,
  writeSelection,
  wrapUntrusted,
  type SynapseProbeResult,
} from "../../../../../.opencode/tool/cas-bridge-lib"

const mockInput = {} as any

const originalToken = process.env.CAS_MCP_TOKEN
const originalEnabled = process.env.CAS_BRIDGE_ROUTING_ENABLED
const originalDisabled = process.env.CAS_BRIDGE_ROUTING_DISABLED
const originalAllow = process.env.CAS_AGENT_ALLOWLIST

function restoreEnv() {
  if (originalToken === undefined) delete process.env.CAS_MCP_TOKEN
  else process.env.CAS_MCP_TOKEN = originalToken
  if (originalEnabled === undefined) delete process.env.CAS_BRIDGE_ROUTING_ENABLED
  else process.env.CAS_BRIDGE_ROUTING_ENABLED = originalEnabled
  if (originalDisabled === undefined) delete process.env.CAS_BRIDGE_ROUTING_DISABLED
  else process.env.CAS_BRIDGE_ROUTING_DISABLED = originalDisabled
  if (originalAllow === undefined) delete process.env.CAS_AGENT_ALLOWLIST
  else process.env.CAS_AGENT_ALLOWLIST = originalAllow
}

function clearRoutingEnv() {
  delete process.env.CAS_MCP_TOKEN
  delete process.env.CAS_BRIDGE_ROUTING_ENABLED
  delete process.env.CAS_BRIDGE_ROUTING_DISABLED
  delete process.env.CAS_AGENT_ALLOWLIST
}

describe("cas-bridge-routing plugin", () => {
  let hooks: any

  beforeAll(async () => {
    clearRoutingEnv()
    hooks = await plugin(mockInput)
  })

  beforeEach(() => {
    clearRoutingEnv()
  })

  afterEach(() => {
    restoreEnv()
  })

  test("returns system.transform hook", () => {
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function")
  })

  test("degraded mode when not connected", async () => {
    delete process.env.CAS_MCP_TOKEN
    const localHooks: any = await plugin(mockInput)
    const output = { system: [] as string[] }
    await localHooks["experimental.chat.system.transform"]({}, output)
    expect(output.system.length).toBe(1)
    expect(output.system[0]).toContain("not connected")
    expect(output.system[0]).toContain("opencode mcp auth alterspective-agent")
  })

  test("routing prompt when token present", async () => {
    process.env.CAS_MCP_TOKEN = "test-token-not-real"
    const localHooks: any = await plugin(mockInput)
    const output = { system: [] as string[] }
    await localHooks["experimental.chat.system.transform"]({}, output)
    expect(output.system[0]).toContain("CAS bridge")
    expect(output.system[0]).toContain("cas_select_agent")
    expect(output.system[0]).toContain("untrusted")
    expect(output.system[0]).toContain("cas_safe_run_insights")
    expect(output.system[0]).toContain("synapse_probe")
    expect(output.system[0]).toContain("x-synapse-served-model")
  })

  test("disabled via CAS_BRIDGE_ROUTING_DISABLED", async () => {
    process.env.CAS_BRIDGE_ROUTING_DISABLED = "true"
    const localHooks: any = await plugin(mockInput)
    const output = { system: [] as string[] }
    await localHooks["experimental.chat.system.transform"]({}, output)
    expect(output.system.length).toBe(0)
  })
})

describe("cas-bridge-lib validation", () => {
  beforeEach(() => {
    clearRoutingEnv()
  })

  afterEach(() => {
    restoreEnv()
  })

  test("casTokenPresent and casAuthSource for env", () => {
    delete process.env.CAS_MCP_TOKEN
    expect(casTokenPresent()).toBe(false)
    expect(casAuthSource()).toBe("none")
    process.env.CAS_MCP_TOKEN = "x"
    expect(casTokenPresent()).toBe(true)
    expect(casAuthSource()).toBe("env")
  })

  test("validateDelegate accepts allowlisted agent", () => {
    const r = validateDelegate({ agentId: "drafter", task: "Draft a short status email for the client." })
    expect(r.ok).toBe(true)
  })

  test("validateDelegate rejects unknown agent", () => {
    const r = validateDelegate({ agentId: "evil-exfil", task: "hello" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("allowlist")
  })

  test("validateDelegate rejects oversized task", () => {
    const r = validateDelegate({ agentId: "drafter", task: "x".repeat(9000) })
    expect(r.ok).toBe(false)
  })

  test("looksLikeSecret detects private keys and Bearer in long payloads", () => {
    expect(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe(true)
    const padding = "context ".repeat(200)
    expect(looksLikeSecret(`${padding} Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345`)).toBe(true)
  })

  test("looksLikeSourceCode detects large code dumps", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `import { foo${i} } from "./m${i}"`).join("\n")
    expect(looksLikeSourceCode(lines)).toBe(true)
  })

  test("wrapUntrusted fences output and truncates large bodies", () => {
    const out = wrapUntrusted("test", "do something bad")
    expect(out).toContain("BEGIN_UNTRUSTED_CAS_OUTPUT")
    expect(out).toContain("untrusted third-party text")
    const big = "z".repeat(MAX_RESPONSE_CHARS + 500)
    expect(wrapUntrusted("big", big)).toContain("[truncated")
  })

  test("writeSelection and readSelection round-trip", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-sel-"))
    try {
      writeSelection(dir, {
        agentId: "drafter",
        name: "Drafter",
        selectedAt: "2026-08-01T00:00:00.000Z",
      })
      const got = readSelection(dir)
      expect(got?.agentId).toBe("drafter")
      expect(got?.name).toBe("Drafter")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("cas-bridge insights helpers", () => {
  const sampleRun = {
    id: "run_abc",
    sessionId: "ses_1",
    status: "succeeded",
    templateId: "drafter",
    trigger: "api",
    title: "Draft a short status email",
    loopTurns: 3,
    promptTokens: 1200,
    completionTokens: 400,
    correlationId: "corr-xyz",
    createdAt: "2026-08-01T10:00:00.000Z",
    startedAt: "2026-08-01T10:00:01.000Z",
    endedAt: "2026-08-01T10:00:11.000Z",
  }

  test("formatRunInsights includes tokens correlation and wall time", () => {
    const text = formatRunInsights(sampleRun)
    expect(text).toContain("run_abc")
    expect(text).toContain("succeeded")
    expect(text).toContain("drafter")
    expect(text).toContain("prompt=1200")
    expect(text).toContain("completion=400")
    expect(text).toContain("total=1600")
    expect(text).toContain("corr-xyz")
    expect(text).toContain("10.0 s")
    expect(text).toContain("Synapse")
  })

  test("formatRunList and empty list", () => {
    expect(formatRunList([])).toContain("No CAS runs")
    const list = formatRunList([sampleRun])
    expect(list).toContain("run_abc")
    expect(list).toContain("tokens=1600")
    expect(list).toContain("cas_safe_run_insights")
  })

  test("parseCasRunPayload accepts run wrapper and raw run", () => {
    expect(parseCasRunPayload(JSON.stringify(sampleRun))?.id).toBe("run_abc")
    expect(parseCasRunPayload(JSON.stringify({ run: sampleRun }))?.id).toBe("run_abc")
    expect(
      parseCasRunPayload(`text\n\nstructuredContent:\n${JSON.stringify({ run: sampleRun })}`)?.id,
    ).toBe("run_abc")
  })

  test("parseCasRunListPayload accepts runs array", () => {
    const runs = parseCasRunListPayload(JSON.stringify({ runs: [sampleRun] }))
    expect(runs).toHaveLength(1)
    expect(runs[0].id).toBe("run_abc")
  })

  test("formatRunTrace summarises event types", () => {
    const text = formatRunTrace({
      data: {
        run: sampleRun,
        events: [
          { type: "prompt", at: "2026-08-01T10:00:01.000Z" },
          { type: "tool_call", toolName: "sharedo_search", at: "2026-08-01T10:00:02.000Z" },
          { type: "tool_result", toolName: "sharedo_search", at: "2026-08-01T10:00:03.000Z" },
          { type: "response", at: "2026-08-01T10:00:10.000Z" },
        ],
      },
      meta: { eventCount: 4 },
    })
    expect(text).toContain("tool_call")
    expect(text).toContain("sharedo_search")
    expect(text).toContain("Step trace (4 events)")
  })

  test("extractSynapseHeaders and formatSynapseProbe", () => {
    const headers = new Headers({
      "x-synapse-served-model": "qwen3-next-80b",
      "x-ratelimit-limit": "120",
      "x-ratelimit-remaining": "119",
    })
    const extracted = extractSynapseHeaders(headers)
    expect(extracted.servedModel).toBe("qwen3-next-80b")
    expect(extracted.rateLimitRemaining).toBe("119")

    const probe: SynapseProbeResult = {
      ok: true,
      status: 200,
      latencyMs: 42,
      requestedModel: "auto",
      bodyModel: "qwen3-next-80b",
      usage: { prompt_tokens: 13, completion_tokens: 2, total_tokens: 15 },
      contentPreview: "pong",
      headers: extracted,
      correlationId: "probe-1",
    }
    const text = formatSynapseProbe(probe)
    expect(text).toContain("x-synapse-served-model")
    expect(text).toContain("qwen3-next-80b")
    expect(text).toContain("119 remaining of 120")
    expect(text).toContain("total=15")
  })

  test("formatPipelineStatus and duration helpers", () => {
    expect(durationMs("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:01.500Z")).toBe(1500)
    expect(formatDuration(1500)).toBe("1.5 s")
    const text = formatPipelineStatus({
      cas: {
        status: "healthy",
        version: "1.0.161",
        sha: "23e7ae1",
        environmentLabel: "PROD",
        llm: "LangfuseLlmBackend",
        knowledgeHealthy: true,
        gateway: {
          baseUrl: "https://synapse2-api.alterspective.com.au",
          endpoint: "/v1/chat/completions",
          model: "anthropic/claude-haiku-4.5",
        },
        observability: { langfuse: true, metrics: "log" },
      },
      synapse: { status: "ok", version: "0.0.0-prod", sha: "e35489b", label: "PROD" },
      casAuth: "oauth (mcp-auth.json)",
      synapseAuth: "present via SYNAPSE_API_KEY",
    })
    expect(text).toContain("1.0.161")
    expect(text).toContain("synapse2-api")
    expect(text).toContain("cas_safe_run_insights")
    expect(text).toContain("synapse_probe")
  })

  test("redactSecrets and synapseKeySource", () => {
    expect(redactSecrets("Bearer supersecret-token-value")).toContain("[redacted]")
    expect(redactSecrets("key gpaas_abcdefghijklmnop")).toContain("[redacted]")
    const prev = process.env.SYNAPSE_API_KEY
    delete process.env.SYNAPSE_API_KEY
    delete process.env.GPAAS_API_KEY
    delete process.env.SYNAPSE_MCP_BEARER_TOKEN
    expect(synapseKeySource()).toBe("none")
    process.env.GPAAS_API_KEY = "test"
    expect(synapseKeySource()).toBe("GPAAS_API_KEY")
    if (prev === undefined) delete process.env.SYNAPSE_API_KEY
    else process.env.SYNAPSE_API_KEY = prev
    delete process.env.GPAAS_API_KEY
  })
})
