import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  accessTokenIsExpiring,
  extractToolCallsFromModelOutput,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  parseJwtPayload,
  refreshKeystoneToken,
  normalizeSystemMessages,
  registerKeystoneClient,
  SynapseAuthPlugin,
  audienceIsSynapse,
  buildHandoffLoginUrl,
  redirectUri,
  exchangeHandoffForSynapseToken,
  HANDOFF_APP_ID,
  SERVED_MODELS_FILE_ENV,
  recordServedModelSideband,
  resolveBrokerKey,
  containsToolCallMarkup,
  hasPendingMarkupRepair,
  takePendingMarkupRepair,
  resetMarkupRepairState,
  getEscalationSnapshot,
} from "../../src/plugin/synapse"

function makeJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("SynapseAuthPlugin", () => {
  test("parses JWT payload successfully", () => {
    const jwt = makeJwt({ sub: "user-123", email: "igor@alterspective.com.au", exp: 1700000000 })
    const parsed = parseJwtPayload(jwt)
    expect(parsed?.sub).toBe("user-123")
    expect(parsed?.email).toBe("igor@alterspective.com.au")
  })

  test("returns true for an expired JWT", () => {
    const expiredJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 })
    expect(accessTokenIsExpiring(expiredJwt, 0)).toBe(true)
  })

  test("returns false for a fresh JWT outside skew", () => {
    const freshJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    expect(accessTokenIsExpiring(freshJwt, 0)).toBe(false)
  })

  test("returns true when within skew window", () => {
    const nearExpiryJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 30 })
    expect(accessTokenIsExpiring(nearExpiryJwt, 60_000)).toBe(true)
    expect(accessTokenIsExpiring(nearExpiryJwt, 0)).toBe(false)
  })

  test("returns false for invalid token strings", () => {
    expect(accessTokenIsExpiring("invalid-token", 0)).toBe(false)
    expect(accessTokenIsExpiring(undefined, 0)).toBe(false)
  })

  test("builds valid Keystone OAuth URL with audience=synapse", () => {
    const pkce = { verifier: "ver-123", challenge: "chal-456" }
    const urlString = buildAuthorizeUrl({
      clientId: "client-abc",
      redirectUri: "http://127.0.0.1:1459/auth/callback",
      pkce,
      state: "state-789",
    })
    const url = new URL(urlString)

    expect(url.origin + url.pathname).toBe("https://identity.alterspective.com.au/api/oauth/authorize")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("client-abc")
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1459/auth/callback")
    expect(url.searchParams.get("audience")).toBe("synapse")
    expect(url.searchParams.get("scope")).toContain("mcp:gpaas")
    expect(url.searchParams.get("code_challenge")).toBe("chal-456")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("state")).toBe("state-789")
  })

  test("registers client and exchanges token successfully with mock fetcher", async () => {
    let requestedAudience = ""
    const mockFetch: any = async (input: any, init: any) => {
      const url = String(input)
      if (url.includes("/register")) {
        return new Response(JSON.stringify({ client_id: "test-client-id" }), { status: 200 })
      }
      if (url.includes("/token")) {
        const body = typeof init?.body === "string" ? init.body : (init?.body as any)?.toString()
        const searchParams = new URLSearchParams(body)
        requestedAudience = searchParams.get("audience") || ""

        return new Response(
          JSON.stringify({
            access_token: "test-access-token",
            refresh_token: "test-refresh-token",
            expires_in: 3600,
          }),
          { status: 200 },
        )
      }
      return new Response("Not found", { status: 404 })
    }

    const reg = await registerKeystoneClient("http://127.0.0.1:1459/auth/callback", mockFetch)
    expect(reg.clientId).toBe("test-client-id")

    const tokens = await exchangeCodeForTokens(
      {
        clientId: reg.clientId,
        code: "auth-code",
        redirectUri: "http://127.0.0.1:1459/auth/callback",
        verifier: "test-verifier",
      },
      mockFetch,
    )
    expect(tokens.access_token).toBe("test-access-token")
    expect(tokens.refresh_token).toBe("test-refresh-token")
    expect(requestedAudience).toBe("synapse")

    const refreshed = await refreshKeystoneToken(
      {
        clientId: reg.clientId,
        refreshToken: tokens.refresh_token!,
      },
      mockFetch,
    )
    expect(refreshed.access_token).toBe("test-access-token")
  })

  test("exposes synapse provider with oauth and api methods, and synapse_probe tool", async () => {
    const pluginInput = {
      client: {} as never,
      project: {} as never,
      directory: "",
      worktree: "",
      experimental_workspace: { register() {} },
      serverUrl: new URL("https://example.com"),
      $: {} as never,
    }

    const hooks = await SynapseAuthPlugin(pluginInput)
    expect(hooks.auth?.provider).toBe("synapse")
    expect(hooks.auth?.methods.length).toBe(2)
    expect(hooks.auth?.methods[0].type).toBe("oauth")
    expect(hooks.auth?.methods[1].type).toBe("api")
    expect(hooks.tool?.synapse_probe).toBeDefined()
    expect(hooks.tool?.synapse_probe.description).toContain("Built-in Synapse provider telemetry probe")
    expect(hooks.tool?.synapse_probe.description).toContain("synapse_probe")

    const probeEmpty = await hooks.tool!.synapse_probe.execute({}, {} as never)
    expect(probeEmpty).toContain("Synapse is connected")
  })
})
describe('normalizeSystemMessages', () => {
  test('collapses multiple leading system messages into one', () => {
    const out = normalizeSystemMessages([
      { role: 'system', content: 'header' },
      { role: 'system', content: 'block A' },
      { role: 'system', content: 'block B' },
      { role: 'user', content: 'hi' },
    ])
    expect(out.length).toBe(2)
    expect(out[0].role).toBe('system')
    expect(out[0].content).toContain('header')
    expect(out[0].content).toContain('block A')
    expect(out[0].content).toContain('block B')
    expect(out[1]).toEqual({ role: 'user', content: 'hi' })
  })

  test('moves a mid-conversation system message to the single leading system', () => {
    const out = normalizeSystemMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
      { role: 'system', content: 'late note' },
    ])
    expect(out.length).toBe(3)
    expect(out[0].role).toBe('system')
    expect(out[0].content).toContain('late note')
    expect(out[2].role).toBe('assistant')
  })

  test('leaves a single leading system message untouched', () => {
    const msgs = [
      { role: 'system', content: 'only' },
      { role: 'user', content: 'hi' },
    ]
    expect(normalizeSystemMessages(msgs)).toBe(msgs)
  })
})
describe("extractToolCallsFromModelOutput", () => {
  const TC = "<" + "tool_call>"
  const TCE = "<" + "/tool_call>"
  const INV = "<" + ">"
  const FN = "<" + "function="
  const FNC = "<" + "/function>"
  const PR = "<" + "parameter="
  const PRC = "<" + "/parameter>"

  test("parses JSON tool_call tags", () => {
    const out = extractToolCallsFromModelOutput(
      `Working. ${TC}{"name": "read", "arguments": {"filePath": "a.ts"}}${TCE}`,
    )
    expect(out.toolCalls.length).toBe(1)
    expect(out.toolCalls[0].function.name).toBe("read")
    expect(out.cleanText).toBe("Working.")
  })

  test("parses Cline-style function blocks", () => {
    const block = FN + "read>\n" + PR + "filePath>\nC:\\x\\a.ts\n" + PRC + "\n" + FNC
    const out = extractToolCallsFromModelOutput(INV + "\n" + block + "\n" + INV)
    expect(out.toolCalls.length).toBe(1)
    expect(out.toolCalls[0].function.name).toBe("read")
    expect(JSON.parse(out.toolCalls[0].function.arguments)).toEqual({ filePath: "C:\\x\\a.ts" })
    expect(out.cleanText).toBe("")
  })

  test("normalizes rag tool aliases inside text calls", () => {
    const out = extractToolCallsFromModelOutput(`${TC}{"name": "rag_ask", "arguments": {"question": "q"}}${TCE}`)
    expect(out.toolCalls[0].function.name).toBe("alterspective-rag_rag_ask")
  })
})

describe("audienceIsSynapse", () => {
  test("true for a synapse-audience Keystone JWT", () => {
    expect(audienceIsSynapse(makeJwt({ aud: "synapse", sub: "keystone:entra:abc" }))).toBe(true)
  })

  test("true when aud is an array containing synapse", () => {
    expect(audienceIsSynapse(makeJwt({ aud: ["synapse", "other"] }))).toBe(true)
  })

  test("false for an MCP-resource audience token (must use the bridge)", () => {
    expect(audienceIsSynapse(makeJwt({ aud: "https://synapse-mcp.alterspective.com.au/mcp" }))).toBe(false)
  })

  test("false for non-JWT tokens", () => {
    expect(audienceIsSynapse("sk-static-key")).toBe(false)
    expect(audienceIsSynapse(undefined)).toBe(false)
  })
})

describe("handoff login flow", () => {
  test("builds the Keystone handoff login URL with app, nonce and returnTo", () => {
    const url = new URL(
      buildHandoffLoginUrl({ redirectUri: "http://localhost:1459/auth/callback", nonce: "n-1" }),
    )
    expect(url.origin + url.pathname).toBe("https://identity.alterspective.com.au/api/auth/login")
    expect(url.searchParams.get("app")).toBe(HANDOFF_APP_ID)
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1459/auth/callback")
    expect(url.searchParams.get("nonce")).toBe("n-1")
    expect(url.searchParams.get("returnTo")).toBe("/")
  })

  test("exchanges the handoff with the broker key and requests offline access", async () => {
    let seen: { url: string; auth: string; body: URLSearchParams; redirect?: string } | undefined
    const mockFetch: any = async (input: any, init: any) => {
      seen = {
        url: String(input),
        auth: String(init?.headers?.Authorization ?? init?.headers?.authorization ?? ""),
        body: new URLSearchParams(String(init?.body)),
        redirect: init?.redirect,
      }
      return new Response(JSON.stringify({ access_token: "syn-token", refresh_token: "rt-1", expires_in: 3600 }), {
        status: 200,
      })
    }
    const tokens = await exchangeHandoffForSynapseToken(
      { handoff: "handoff-token", brokerKey: "ks_live_broker", offline: true },
      mockFetch,
    )
    expect(tokens.access_token).toBe("syn-token")
    expect(tokens.refresh_token).toBe("rt-1")
    expect(seen?.url).toBe("https://identity.alterspective.com.au/api/oidc/token")
    expect(seen?.auth).toBe("Bearer ks_live_broker")
    expect(seen?.body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange")
    expect(seen?.body.get("subject_token")).toBe("handoff-token")
    expect(seen?.body.get("audience")).toBe("synapse")
    expect(seen?.body.get("scope")).toBe("offline_access")
    // Credential-bearing request must not follow a redirect off-origin.
    expect(seen?.redirect).toBe("error")
  })

  test("throws when the exchange is refused", async () => {
    const mockFetch: any = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    await expect(
      exchangeHandoffForSynapseToken({ handoff: "h", brokerKey: "k" }, mockFetch),
    ).rejects.toThrow(/invalid_grant/)
  })
})

describe("callback host", () => {
  test("redirects to explicit loopback IPv4 so the 127.0.0.1 listener is reachable", () => {
    // Windows resolves "localhost" to ::1 first; the callback server binds 127.0.0.1,
    // so a localhost redirect produced ERR_CONNECTION_REFUSED.
    expect(redirectUri()).toBe("http://127.0.0.1:1459/auth/callback")
    expect(redirectUri(1459)).not.toContain("localhost")
  })
})

describe("#257: recordServedModelSideband", () => {
  test("atomically records served model counts by session and totals when SBXW_SERVED_MODELS_FILE is set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbxw-sideband-"))
    const file = path.join(dir, "served-models.json")
    try {
      await recordServedModelSideband("qwen/qwen3.6-35b-a3b", "sess-1", file)
      await recordServedModelSideband("qwen/qwen3.6-35b-a3b", "sess-1", file)
      await recordServedModelSideband("claude-sonnet-4.5", undefined, file)

      const raw = JSON.parse(await fs.readFile(file, "utf8"))
      expect(raw.lastServedModel).toBe("claude-sonnet-4.5")
      expect(raw.bySession["sess-1"]).toEqual({ "qwen/qwen3.6-35b-a3b": 2 })
      expect(raw.bySession["global"]).toEqual({ "claude-sonnet-4.5": 1 })
      expect(raw.totals).toEqual({
        "qwen/qwen3.6-35b-a3b": 2,
        "claude-sonnet-4.5": 1,
      })
      expect(typeof raw.updatedAt).toBe("string")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("never throws when sideband path is unset or unwritable", async () => {
    const prev = process.env[SERVED_MODELS_FILE_ENV]
    delete process.env[SERVED_MODELS_FILE_ENV]
    try {
      await expect(recordServedModelSideband("qwen/qwen3.6-35b-a3b", "sess-1", "")).resolves.toBeUndefined()
      await expect(recordServedModelSideband("", "sess-1", "/tmp/unused.json")).resolves.toBeUndefined()
      await expect(
        recordServedModelSideband("qwen/qwen3.6-35b-a3b", "sess-1", "/nonexistent/\0/bad.json"),
      ).resolves.toBeUndefined()
    } finally {
      if (prev !== undefined) process.env[SERVED_MODELS_FILE_ENV] = prev
    }
  })
})

describe("#248: public-client PKCE fallback and concrete error reporting", () => {
  test("resolveBrokerKey returns empty string when OPENCODE_KEYSTONE_BROKER_KEY is unset", () => {
    const prev = process.env.OPENCODE_KEYSTONE_BROKER_KEY
    delete process.env.OPENCODE_KEYSTONE_BROKER_KEY
    try {
      expect(resolveBrokerKey()).toBe("")
      expect(resolveBrokerKey({ OPENCODE_KEYSTONE_BROKER_KEY: "  ks_live_abc  " })).toBe("ks_live_abc")
    } finally {
      if (prev !== undefined) process.env.OPENCODE_KEYSTONE_BROKER_KEY = prev
    }
  })

  test("falls back to public-client PKCE flow when OPENCODE_KEYSTONE_BROKER_KEY is unset, and surfaces concrete errors via TUI toast", async () => {
    const prevBroker = process.env.OPENCODE_KEYSTONE_BROKER_KEY
    delete process.env.OPENCODE_KEYSTONE_BROKER_KEY

    const toasts: Array<{ title?: string; message?: string; variant?: string }> = []
    const origFetch = globalThis.fetch
    let registerCalls = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/oauth/register")) {
        registerCalls++
        if (registerCalls === 1) {
          return new Response(JSON.stringify({ client_id: "pkce-fallback-client" }), { status: 200 })
        }
        return new Response("registration boom", { status: 502 })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const pluginInput = {
      client: {
        tui: {
          showToast: async (opts: { body: { title?: string; message?: string; variant?: string } }) => {
            toasts.push(opts.body)
          },
        },
      } as never,
      project: {} as never,
      directory: "",
      worktree: "",
      experimental_workspace: { register() {} },
      serverUrl: new URL("https://example.com"),
      $: {} as never,
    }

    try {
      const hooks = await SynapseAuthPlugin(pluginInput, {
        oauthPort: 19459,
        openBrowser: async () => undefined,
      })

      const oauthMethod = hooks.auth?.methods[0]
      expect(oauthMethod?.type).toBe("oauth")
      if (!oauthMethod || oauthMethod.type !== "oauth") throw new Error("missing oauth method")

      // 1) When DCR succeeds with no broker key, authorize returns the PKCE authorize URL
      const authStart = await oauthMethod.authorize()
      expect(registerCalls).toBe(1)
      expect(authStart.url).toContain("/api/oauth/authorize")
      expect(authStart.url).toContain("client_id=pkce-fallback-client")
      expect(authStart.url).toContain("code_challenge_method=S256")

      // Close the callback server by sending an oauth error redirect
      const redirectParam = new URL(authStart.url).searchParams.get("redirect_uri")!
      await origFetch(`${redirectParam}?error=access_denied`).catch(() => undefined)
      const callbackRes = await (authStart.callback as () => Promise<{ type: string }>)()
      expect(callbackRes).toEqual({ type: "failed" })
      expect(toasts.length).toBeGreaterThanOrEqual(1)
      expect(toasts[0]?.variant).toBe("error")

      // 2) When DCR fails during PKCE fallback, authorize logs + shows toast and callback returns { type: "failed" }
      const hooks2 = await SynapseAuthPlugin(pluginInput, {
        oauthPort: 19460,
        openBrowser: async () => undefined,
      })
      const oauthMethod2 = hooks2.auth?.methods[0]
      if (!oauthMethod2 || oauthMethod2.type !== "oauth") throw new Error("missing oauth method")
      const failedStart = await oauthMethod2.authorize()
      const failedCallback = await (failedStart.callback as () => Promise<{ type: string }>)()
      expect(failedCallback).toEqual({ type: "failed" })
      expect(toasts.some((t) => (t.message ?? "").includes("502"))).toBe(true)
    } finally {
      globalThis.fetch = origFetch
      if (prevBroker === undefined) delete process.env.OPENCODE_KEYSTONE_BROKER_KEY
      else process.env.OPENCODE_KEYSTONE_BROKER_KEY = prevBroker
    }
  })
})

describe("#20: containsToolCallMarkup and experimental.text.complete bounded 1-shot repair", () => {
  test("containsToolCallMarkup detects raw tool-call tags and ignores normal prose", () => {
    const open = "<" + "tool_call>"
    const close = "<" + "/tool_call>"
    expect(containsToolCallMarkup(`Here is the call: ${open}{"name":"bash"}${close}`)).toBe(true)
    expect(containsToolCallMarkup("<function=read><parameter=filePath>a.ts</parameter></function>")).toBe(true)
    expect(containsToolCallMarkup("Normal response without any markup tags.")).toBe(false)
    expect(containsToolCallMarkup(`Quoted inline: \`${open}{"name":"bash"}${close}\` in prose`)).toBe(false)
    expect(containsToolCallMarkup(`\`\`\`xml\n${open}{"name":"bash"}${close}\n\`\`\`` )).toBe(false)
    expect(containsToolCallMarkup("<|DSML|tool_calls>")).toBe(true)
    expect(containsToolCallMarkup("")).toBe(false)
  })

  test("experimental.text.complete records malformed-output and arms at most 1 repair per turn", async () => {
    const sessionID = "sess-markup-20"
    resetMarkupRepairState(sessionID)

    const hooks = await SynapseAuthPlugin({
      client: {} as never,
      project: {} as never,
      directory: "",
      worktree: "",
      experimental_workspace: { register() {} },
      serverUrl: new URL("https://example.com"),
      $: {} as never,
    })

    const textComplete = hooks["experimental.text.complete"]
    expect(textComplete).toBeDefined()

    const open = "<" + "tool_call>"
    const close = "<" + "/tool_call>"

    // First malformed response on message msg-1 arms the 1-shot repair
    await textComplete!(
      { sessionID, messageID: "msg-1", partID: "part-1" },
      { text: `Let me run that:\n${open}{"name":"bash","arguments":{"command":"ls"}}${close}` },
    )

    expect(hasPendingMarkupRepair(sessionID, "msg-1")).toBe(true)
    expect(takePendingMarkupRepair(sessionID, "msg-1")).toBe(true)
    // Consumed after takePendingMarkupRepair
    expect(hasPendingMarkupRepair(sessionID, "msg-1")).toBe(false)

    // Second firing in the same turn (retry message msg-2) must not re-arm (bounded 1-shot)
    await textComplete!(
      { sessionID, messageID: "msg-2", partID: "part-2" },
      { text: `${open}{"name":"bash","arguments":{"command":"pwd"}}${close}` },
    )
    expect(hasPendingMarkupRepair(sessionID, "msg-2")).toBe(false)

    // After 2 malformed-output failures in the same session, escalation is armed
    const snap = getEscalationSnapshot(sessionID)
    expect(snap.consecutiveFailures).toEqual({ cls: "malformed-output", count: 2 })
  })
})
