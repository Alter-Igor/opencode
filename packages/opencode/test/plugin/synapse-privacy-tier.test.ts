import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import {
  SYNAPSE_PRIVACY_TIER_ENV,
  SynapseAuthPlugin,
  applyPrivacyTierHeader,
  forcedPrivacyTier,
  setLatestSynapseServing,
} from "../../src/plugin/synapse"

// #101: the sandbox supervisor forces `x-privacy-tier` on every Synapse call: `local-only` by default,
// `cloud-ok` only when the manifest says exactly that (#161). The plugin must pass `cloud-ok` through.

const BASE = "https://synapse-privacy.example.test/v1"
const API_KEY = "sk-test-privacy-tier-0123456789abcdef"
const MCP = "https://synapse-mcp.alterspective.com.au/mcp"

const pluginInput = {
  client: {} as never,
  project: {} as never,
  directory: "",
  worktree: "",
  experimental_workspace: { register() {} },
  serverUrl: new URL("https://example.com"),
  $: {} as never,
}

type Call = { href: string; headers: Headers; body?: any }

/** Runs `fn` with fetch stubbed for the gateway and the MCP host; returns what was sent. */
async function capture(fn: () => Promise<void>, env?: string): Promise<Call[]> {
  const previousFetch = globalThis.fetch
  const previousEnv = process.env[SYNAPSE_PRIVACY_TIER_ENV]
  if (env === undefined) delete process.env[SYNAPSE_PRIVACY_TIER_ENV]
  else process.env[SYNAPSE_PRIVACY_TIER_ENV] = env
  const calls: Call[] = []
  const stub = async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    if (!href.startsWith(BASE) && !href.startsWith(MCP)) return previousFetch(url, init)
    calls.push({ href, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (href === `${BASE}/models`) {
      return Response.json({ object: "list", data: [{ id: "live-model-1", capabilities: { ops: ["chat"], tools: true } }] })
    }
    if (href.startsWith(MCP)) {
      return Response.json({ result: { structuredContent: { content: "hello", servedModel: "qwen/qwen3.8-flash" } } })
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] })
  }
  globalThis.fetch = Object.assign(stub, { preconnect: previousFetch.preconnect })
  try {
    await fn()
    return calls
  } finally {
    setLatestSynapseServing(undefined)
    globalThis.fetch = previousFetch
    if (previousEnv === undefined) delete process.env[SYNAPSE_PRIVACY_TIER_ENV]
    else process.env[SYNAPSE_PRIVACY_TIER_ENV] = previousEnv
  }
}

async function chat(input: { key: string; headers?: Record<string, string>; metadata?: Record<string, string> }) {
  const hooks = await SynapseAuthPlugin(pluginInput, { inferenceUrl: BASE })
  const stored = { type: "api", key: input.key, metadata: input.metadata }
  const loaded = await hooks.auth?.loader?.(async () => stored as never, {} as never)
  const chatFetch = loaded?.fetch as (u: string, i: RequestInit) => Promise<Response>
  const response = await chatFetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...input.headers },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
  })
  expect(response.status).toBe(200)
}

describe("forcedPrivacyTier (#101)", () => {
  test("unset or empty forces nothing", () => {
    expect(forcedPrivacyTier({})).toBeUndefined()
    expect(forcedPrivacyTier({ [SYNAPSE_PRIVACY_TIER_ENV]: "" })).toBeUndefined()
  })

  test("spaces only still force local-only", () => {
    expect(forcedPrivacyTier({ [SYNAPSE_PRIVACY_TIER_ENV]: "  " })).toBe("local-only")
  })

  test("local-only forces local-only", () => {
    expect(forcedPrivacyTier({ [SYNAPSE_PRIVACY_TIER_ENV]: "local-only" })).toBe("local-only")
  })

  test("cloud-ok passes through, only when it is exactly cloud-ok", () => {
    expect(forcedPrivacyTier({ [SYNAPSE_PRIVACY_TIER_ENV]: "cloud-ok" })).toBe("cloud-ok")
  })

  test("any other value narrows to local-only, never widens", () => {
    for (const value of ["locla-only", "Cloud-OK", "CLOUD-OK", " cloud-ok", "cloud-ok ", "cloud-ok\n", "cloud", "cloud_ok", "true", "1", " "]) {
      expect(forcedPrivacyTier({ [SYNAPSE_PRIVACY_TIER_ENV]: value })).toBe("local-only")
    }
  })
})

describe("applyPrivacyTierHeader (#101)", () => {
  test("replaces a configured tier and keeps the other headers", () => {
    const cfg = { provider: { synapse: { options: { baseURL: BASE, headers: { "x-privacy-tier": "cloud-ok", "x-task-type": "code" } } } } }
    applyPrivacyTierHeader(cfg, "local-only")
    expect(cfg.provider.synapse.options).toEqual({
      baseURL: BASE,
      headers: { "x-privacy-tier": "local-only", "x-task-type": "code" },
    })
  })

  test("sets cloud-ok over a configured local-only header", () => {
    const cfg: { provider: Record<string, any> } = { provider: { synapse: { options: { headers: { "x-privacy-tier": "local-only" } } } } }
    applyPrivacyTierHeader(cfg, "cloud-ok")
    expect(cfg.provider.synapse.options.headers).toEqual({ "x-privacy-tier": "cloud-ok" })
  })

  test("adds options when the provider has none", () => {
    const cfg: { provider: Record<string, any> } = { provider: { synapse: {} } }
    applyPrivacyTierHeader(cfg, "local-only")
    expect(cfg.provider.synapse.options.headers).toEqual({ "x-privacy-tier": "local-only" })
  })

  test("drops every spelling of the header, so a fetch cannot send two values", () => {
    const cfg: { provider: Record<string, any> } = {
      provider: { synapse: { options: { headers: { "X-Privacy-Tier": "cloud-ok", "x-task-type": "code" } } } },
    }
    applyPrivacyTierHeader(cfg, "local-only")
    expect(cfg.provider.synapse.options.headers).toEqual({ "x-task-type": "code", "x-privacy-tier": "local-only" })
    expect(new Headers(cfg.provider.synapse.options.headers).get("x-privacy-tier")).toBe("local-only")
  })

  test("does nothing without a synapse provider", () => {
    const cfg = { provider: { other: { options: {} } } }
    applyPrivacyTierHeader(cfg, "local-only")
    expect(cfg).toEqual({ provider: { other: { options: {} } } })
  })
})

describe("every Synapse call carries the forced tier (#101)", () => {
  test("REST chat: a request header cannot widen it", async () => {
    const calls = await capture(() => chat({ key: API_KEY, headers: { "x-privacy-tier": "cloud-ok" } }), "local-only")
    expect(calls).toHaveLength(1)
    expect(calls[0].headers.get("x-privacy-tier")).toBe("local-only")
  })

  test("REST chat: cloud-ok from the environment is sent as cloud-ok, not rewritten to local-only", async () => {
    const calls = await capture(() => chat({ key: API_KEY }), "cloud-ok")
    expect(calls).toHaveLength(1)
    expect(calls[0].headers.get("x-privacy-tier")).toBe("cloud-ok")
  })

  test("REST chat: a request header cannot move a cloud-ok run to another value either", async () => {
    const calls = await capture(() => chat({ key: API_KEY, headers: { "x-privacy-tier": "local-only" } }), "cloud-ok")
    expect(calls[0].headers.get("x-privacy-tier")).toBe("cloud-ok")
  })

  test("REST chat: a junk value in the environment is sent as local-only", async () => {
    const calls = await capture(() => chat({ key: API_KEY, headers: { "x-privacy-tier": "cloud-ok" } }), "Cloud-OK")
    expect(calls[0].headers.get("x-privacy-tier")).toBe("local-only")
  })

  test("REST chat: nothing is added when no tier is forced", async () => {
    const calls = await capture(() => chat({ key: API_KEY }))
    expect(calls).toHaveLength(1)
    expect(calls[0].headers.get("x-privacy-tier")).toBeNull()
  })

  test("MCP bridge chat: the first call already asks for local-only", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
    const payload = Buffer.from(JSON.stringify({ aud: MCP, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
    const calls = await capture(
      () => chat({ key: `${header}.${payload}.sig`, metadata: { expiresAt: String(Date.now() + 3_600_000) } }),
      "local-only",
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].href).toBe(MCP)
    expect(calls[0].body.params.arguments.privacyTier).toBe("local-only")
  })

  test("MCP bridge chat: a cloud-ok run asks for cloud-ok", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
    const payload = Buffer.from(JSON.stringify({ aud: MCP, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
    const calls = await capture(
      () => chat({ key: `${header}.${payload}.sig`, metadata: { expiresAt: String(Date.now() + 3_600_000) } }),
      "cloud-ok",
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].body.params.arguments.privacyTier).toBe("cloud-ok")
  })

  test("model list: the config hook puts the tier on the provider before the list is read", async () => {
    const cfg: any = { provider: { synapse: { npm: "@ai-sdk/openai-compatible", options: { baseURL: BASE, apiKey: "k" }, models: {} } } }
    const calls = await capture(async () => {
      const hooks = await SynapseAuthPlugin(pluginInput, { inferenceUrl: BASE })
      await hooks.config?.(cfg)
    }, "local-only")
    const list = calls.filter((c) => c.href === `${BASE}/models`)
    expect(list).toHaveLength(1)
    expect(list[0].headers.get("x-privacy-tier")).toBe("local-only")
    expect(cfg.provider.synapse.options.headers["x-privacy-tier"]).toBe("local-only")
  })

  test("model list: cloud-ok is put on the provider, replacing a local-only header", async () => {
    const cfg: any = {
      provider: { synapse: { npm: "@ai-sdk/openai-compatible", options: { baseURL: BASE, apiKey: "k", headers: { "x-privacy-tier": "local-only" } }, models: {} } },
    }
    const calls = await capture(async () => {
      const hooks = await SynapseAuthPlugin(pluginInput, { inferenceUrl: BASE })
      await hooks.config?.(cfg)
    }, "cloud-ok")
    const list = calls.filter((c) => c.href === `${BASE}/models`)
    expect(list).toHaveLength(1)
    expect(list[0].headers.get("x-privacy-tier")).toBe("cloud-ok")
    expect(cfg.provider.synapse.options.headers["x-privacy-tier"]).toBe("cloud-ok")
  })

  test("synapse_buddy_review: the MCP chat call asks for local-only", async () => {
    // The tool reads its token from <home>/.local/share/opencode/auth.json. OPENCODE_TEST_HOME
    // moves that home (Bun's os.homedir() ignores HOME on Linux).
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oc-privacy-tier-"))
    const saved = { OPENCODE_TEST_HOME: process.env.OPENCODE_TEST_HOME }
    process.env.OPENCODE_TEST_HOME = home
    try {
      await fs.mkdir(path.join(home, ".local", "share", "opencode"), { recursive: true })
      await fs.writeFile(path.join(home, ".local", "share", "opencode", "auth.json"), JSON.stringify({ synapse: { key: API_KEY } }))
      const calls = await capture(async () => {
        const hooks = await SynapseAuthPlugin(pluginInput, { inferenceUrl: BASE })
        const review = hooks.tool?.synapse_buddy_review
        await review?.execute({ code: "const a = 1" }, {} as never)
      }, "local-only")
      expect(calls).toHaveLength(1)
      expect(calls[0].href).toBe(MCP)
      expect(calls[0].body.params.arguments.privacyTier).toBe("local-only")
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("the plugin option forces the tier without the env var", async () => {
    const calls = await capture(async () => {
      const hooks = await SynapseAuthPlugin(pluginInput, { inferenceUrl: BASE, privacyTier: "local-only" })
      const loaded = await hooks.auth?.loader?.(async () => ({ type: "api", key: API_KEY }) as never, {} as never)
      const chatFetch = loaded?.fetch as (u: string, i: RequestInit) => Promise<Response>
      await chatFetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
      })
    })
    expect(calls[0].headers.get("x-privacy-tier")).toBe("local-only")
  })
})
