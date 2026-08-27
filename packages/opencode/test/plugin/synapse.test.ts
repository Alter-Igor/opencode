import { describe, expect, test } from "bun:test"
import {
  accessTokenIsExpiring,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  parseJwtPayload,
  refreshKeystoneToken,
  registerKeystoneClient,
  SynapseAuthPlugin,
  SYNAPSE_AUDIENCE,
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
    expect(url.searchParams.get("audience")).toBe(SYNAPSE_AUDIENCE)
    expect(url.searchParams.get("scope")).toContain("synapse:inference:invoke")
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
