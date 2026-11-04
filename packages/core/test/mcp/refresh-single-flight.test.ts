import { expect, test } from "bun:test"
import { refreshSingleFlightFetch } from "../../src/mcp/oauth-provider"

function rotatingTokenServer() {
  const state = { grants: 0, reuse: 0, current: "rt-1", revoked: false, generation: 1, issued: new Set<string>() }
  const http = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = new URLSearchParams(await request.text())
      if (body.get("grant_type") !== "refresh_token") return new Response("bad", { status: 400 })
      state.grants++
      await Bun.sleep(50)
      if (state.revoked || body.get("refresh_token") !== state.current) {
        state.reuse++
        state.revoked = true
        return Response.json({ error: "invalid_grant", error_description: "family revoked" }, { status: 400 })
      }
      state.generation++
      state.current = `rt-${state.generation}`
      state.issued.add(`Bearer at-${state.generation}`)
      return Response.json({
        access_token: `at-${state.generation}`,
        token_type: "Bearer",
        refresh_token: state.current,
        expires_in: 3600,
      })
    },
  })
  return { state, tokenUrl: new URL("/token", http.url), stop: () => http.stop(true) }
}

const refresh = async (tokenUrl: URL, refreshToken: string) => {
  const res = await refreshSingleFlightFetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "opencode",
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number }
}

test("concurrent refreshes with the same refresh token make one network grant", async () => {
  const server = rotatingTokenServer()
  try {
    const results = await Promise.all([refresh(server.tokenUrl, "rt-1"), refresh(server.tokenUrl, "rt-1")])
    expect(server.state.grants).toBe(1)
    expect(results[0]).toEqual(results[1])
    expect(results[0].refresh_token).toBe("rt-2")

    // A caller that read rt-1 before it rotated gets the same result, not a reuse.
    const late = await refresh(server.tokenUrl, "rt-1")
    expect(late.refresh_token).toBe("rt-2")
    expect(server.state.grants).toBe(1)

    // The rotated token is a new key and refreshes normally.
    const next = await refresh(server.tokenUrl, "rt-2")
    expect(next.refresh_token).toBe("rt-3")
    expect(server.state.grants).toBe(2)
    expect(server.state.reuse).toBe(0)
  } finally {
    server.stop()
  }
})

test("non-refresh requests pass straight through", async () => {
  let calls = 0
  const http = Bun.serve({
    port: 0,
    fetch() {
      calls++
      return Response.json({ calls })
    },
  })
  try {
    const url = new URL("/token", http.url)
    const body = () => new URLSearchParams({ grant_type: "authorization_code", code: "c" })
    await Promise.all([
      refreshSingleFlightFetch(url, { method: "POST", body: body() }),
      refreshSingleFlightFetch(url, { method: "POST", body: body() }),
      refreshSingleFlightFetch(url),
    ])
    expect(calls).toBe(3)
  } finally {
    http.stop(true)
  }
})
