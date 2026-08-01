import { describe, expect, test, beforeAll, afterEach } from "bun:test"
import plugin from "../../../../../.opencode/plugin/cas-bridge-routing"
import {
  casTokenPresent,
  looksLikeSecret,
  looksLikeSourceCode,
  validateDelegate,
  wrapUntrusted,
} from "../../../../../.opencode/tool/cas-bridge-lib"

const mockInput = {} as any

const originalToken = process.env.CAS_MCP_TOKEN
const originalEnabled = process.env.CAS_BRIDGE_ROUTING_ENABLED
const originalDisabled = process.env.CAS_BRIDGE_ROUTING_DISABLED
const originalAllow = process.env.CAS_AGENT_ALLOWLIST

describe("cas-bridge-routing plugin", () => {
  let hooks: any

  beforeAll(async () => {
    delete process.env.CAS_MCP_TOKEN
    delete process.env.CAS_BRIDGE_ROUTING_ENABLED
    delete process.env.CAS_BRIDGE_ROUTING_DISABLED
    hooks = await plugin(mockInput)
  })

  afterEach(() => {
    if (originalToken === undefined) delete process.env.CAS_MCP_TOKEN
    else process.env.CAS_MCP_TOKEN = originalToken
    if (originalEnabled === undefined) delete process.env.CAS_BRIDGE_ROUTING_ENABLED
    else process.env.CAS_BRIDGE_ROUTING_ENABLED = originalEnabled
    if (originalDisabled === undefined) delete process.env.CAS_BRIDGE_ROUTING_DISABLED
    else process.env.CAS_BRIDGE_ROUTING_DISABLED = originalDisabled
    if (originalAllow === undefined) delete process.env.CAS_AGENT_ALLOWLIST
    else process.env.CAS_AGENT_ALLOWLIST = originalAllow
  })

  test("returns system.transform hook", () => {
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function")
  })

  test("degraded mode when token missing", async () => {
    delete process.env.CAS_MCP_TOKEN
    const localHooks: any = await plugin(mockInput)
    const output = { system: [] as string[] }
    await localHooks["experimental.chat.system.transform"]({}, output)
    expect(output.system.length).toBe(1)
    expect(output.system[0]).toContain("DEGRADED")
    expect(output.system[0]).toContain("CAS_MCP_TOKEN")
  })

  test("routing prompt when token present", async () => {
    process.env.CAS_MCP_TOKEN = "test-token-not-real"
    const localHooks: any = await plugin(mockInput)
    const output = { system: [] as string[] }
    await localHooks["experimental.chat.system.transform"]({}, output)
    expect(output.system[0]).toContain("CAS bridge")
    expect(output.system[0]).toContain("cas_safe_delegate")
    expect(output.system[0]).toContain("untrusted")
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
  afterEach(() => {
    if (originalAllow === undefined) delete process.env.CAS_AGENT_ALLOWLIST
    else process.env.CAS_AGENT_ALLOWLIST = originalAllow
    if (originalToken === undefined) delete process.env.CAS_MCP_TOKEN
    else process.env.CAS_MCP_TOKEN = originalToken
  })

  test("casTokenPresent requires non-empty", () => {
    delete process.env.CAS_MCP_TOKEN
    expect(casTokenPresent()).toBe(false)
    process.env.CAS_MCP_TOKEN = "   "
    expect(casTokenPresent()).toBe(false)
    process.env.CAS_MCP_TOKEN = "x"
    expect(casTokenPresent()).toBe(true)
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

  test("looksLikeSecret detects private keys", () => {
    expect(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe(true)
  })

  test("looksLikeSourceCode detects large code dumps", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `import { foo${i} } from "./m${i}"`).join("\n")
    expect(looksLikeSourceCode(lines)).toBe(true)
  })

  test("wrapUntrusted fences output", () => {
    const out = wrapUntrusted("test", "do something bad")
    expect(out).toContain("BEGIN_UNTRUSTED_CAS_OUTPUT")
    expect(out).toContain("END_UNTRUSTED_CAS_OUTPUT")
    expect(out).toContain("do something bad")
  })
})
