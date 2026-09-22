import { describe, expect, test } from "bun:test"
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
  SYNAPSE_AUDIENCE,
  audienceIsSynapse,
  buildHandoffLoginUrl,
  exchangeHandoffForSynapseToken,
  HANDOFF_APP_ID,
  SYNAPSE_RESOURCE,
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
  const INVE = "<" + "/>"
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
