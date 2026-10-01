// WS2 (#48): the Keystone request shapes the host bridge sends (ported from the fork plugin) and
// what it does with the answers. No real network: a recording fetch stands in for Keystone.
import { describe, expect, test } from "bun:test"
import { DelegateError } from "../src/shared/errors.ts"
import { jwt } from "./synapse-fixture.ts"
import { exchangeHandoff, handoffLoginUrl, lifetimeSec, refreshSynapse, synapseRedirectUri, type Fetch } from "../src/synapse/keystone-token.ts"

const ORIGIN = "https://identity.alterspective.com.au"
const ACCESS = jwt({ sub: "oid-1", email: "owner@example.test", aud: "synapse", act: { sub: "service:opencode" } })

type Seen = { url: string; init: RequestInit; form: URLSearchParams }

function recorder(status: number, body: unknown): { fetch: Fetch; seen: Seen[] } {
  const seen: Seen[] = []
  return {
    seen,
    fetch: async (url, init) => {
      seen.push({ url, init, form: new URLSearchParams(String(init.body)) })
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    },
  }
}

describe("handoff sign-in URL", () => {
  test("is Keystone's handoff login for app opencode with the loopback 1459 callback", () => {
    const url = new URL(handoffLoginUrl(ORIGIN, synapseRedirectUri(), "n0nce"))
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/api/auth/login`)
    expect(Object.fromEntries(url.searchParams)).toEqual({ app: "opencode", redirect_uri: "http://127.0.0.1:1459/auth/callback", nonce: "n0nce", returnTo: "/" })
  })
})

describe("exchange (RFC 8693)", () => {
  test("posts the handoff with the broker key as Bearer, audience synapse and offline_access", async () => {
    const r = recorder(200, { access_token: ACCESS, refresh_token: "rt-1", expires_in: 900 })
    const tokens = await exchangeHandoff(r.fetch, ORIGIN, "handoff.jwt.value", "broker-key")
    expect(r.seen).toHaveLength(1)
    const call = r.seen[0]!
    expect(call.url).toBe(`${ORIGIN}/api/oidc/token`)
    expect(call.init.method).toBe("POST")
    expect(call.init.redirect).toBe("error")
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer broker-key")
    // L5: every Keystone call has a timeout, so a hung call cannot hold the refresh lock.
    expect(call.init.signal).toBeInstanceOf(AbortSignal)
    expect(Object.fromEntries(call.form)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: "handoff.jwt.value",
      audience: "synapse",
      scope: "offline_access",
    })
    // No actor token: the broker credential already makes Keystone stamp act (playbook §4).
    expect(call.form.has("actor_token")).toBe(false)
    expect(tokens).toEqual({ accessToken: ACCESS, refreshToken: "rt-1", expiresInSec: 900 })
  })

  test("a 400 is needs_auth and names no secret", async () => {
    const r = recorder(400, { error: "invalid_grant" })
    const error = await exchangeHandoff(r.fetch, ORIGIN, "handoff-secret", "broker-secret").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DelegateError)
    expect((error as DelegateError).code).toBe("needs_auth")
    const text = JSON.stringify({ m: (error as DelegateError).message, d: (error as DelegateError).detail, a: (error as DelegateError).action })
    expect(text).toContain("invalid_grant")
    expect(text).not.toContain("handoff-secret")
    expect(text).not.toContain("broker-secret")
  })

  test("a token that is not a compact JWT is refused (it would be written into front)", async () => {
    const r = recorder(200, { access_token: 'x"; return 200; #', expires_in: 900 })
    const error = await exchangeHandoff(r.fetch, ORIGIN, "h", "k").catch((e: unknown) => e)
    expect((error as DelegateError).code).toBe("upstream_error")
  })
})

describe("refresh", () => {
  test("posts grant refresh_token for client opencode with its secret and audience synapse", async () => {
    const r = recorder(200, { access_token: ACCESS, expires_in: 3600 })
    const tokens = await refreshSynapse(r.fetch, ORIGIN, "rt-1", "client-secret")
    const call = r.seen[0]!
    expect((call.init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(Object.fromEntries(call.form)).toEqual({ grant_type: "refresh_token", client_id: "opencode", refresh_token: "rt-1", audience: "synapse", client_secret: "client-secret" })
    // No rotation offered: the caller keeps the stored refresh token.
    expect(tokens.refreshToken).toBeUndefined()
  })

  test("a revoked refresh token (401) is needs_auth; a 503 is upstream_error", async () => {
    expect(((await refreshSynapse(recorder(401, {}).fetch, ORIGIN, "rt", "s").catch((e: unknown) => e)) as DelegateError).code).toBe("needs_auth")
    expect(((await refreshSynapse(recorder(503, {}).fetch, ORIGIN, "rt", "s").catch((e: unknown) => e)) as DelegateError).code).toBe("upstream_error")
  })

  test("an unreachable Keystone is upstream_error", async () => {
    const down: Fetch = async () => {
      throw new Error("ECONNREFUSED")
    }
    expect(((await refreshSynapse(down, ORIGIN, "rt", "s").catch((e: unknown) => e)) as DelegateError).code).toBe("upstream_error")
  })
})

describe("N3: an already-expired token is never adopted", () => {
  test("a token with 60 s or less to live is upstream_error (retried with backoff)", async () => {
    const soon = jwt({ sub: "x", exp: Math.floor(Date.now() / 1000) + 30 })
    const error = await refreshSynapse(recorder(200, { access_token: soon, expires_in: 3600 }).fetch, ORIGIN, "rt", "s").catch((e: unknown) => e)
    expect((error as DelegateError).code).toBe("upstream_error")
    const fine = jwt({ sub: "x", exp: Math.floor(Date.now() / 1000) + 600 })
    expect((await refreshSynapse(recorder(200, { access_token: fine, expires_in: 3600 }).fetch, ORIGIN, "rt", "s")).expiresInSec).toBeLessThanOrEqual(600)
  })
})

describe("L4: lifetime = min(expires_in, JWT exp)", () => {
  test("the shorter of the two wins; no exp claim keeps expires_in", () => {
    const now = 1_790_000_000_000
    expect(lifetimeSec(jwt({ exp: now / 1000 + 600 }), 3600, now)).toBe(600)
    expect(lifetimeSec(jwt({ exp: now / 1000 + 7200 }), 3600, now)).toBe(3600)
    expect(lifetimeSec(jwt({ sub: "x" }), 3600, now)).toBe(3600)
    expect(lifetimeSec(jwt({ exp: now / 1000 - 5 }), 3600, now)).toBe(0)
  })
})
