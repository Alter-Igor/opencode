import { createHash } from "node:crypto"

export const OAUTH_CALLBACK_PORT = 19876
export const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

// Alterspective fork (FEAT-OCD-001 §3.4): single-flight refresh-token grants.
const REFRESH_REUSE_MS = 60_000
type SharedResponse = { status: number; statusText: string; headers: [string, string][]; body: string }
const refreshes = new Map<string, Promise<SharedResponse>>()

export const refreshSingleFlightFetch: FetchLike = (url: string | URL, init?: RequestInit) => {
  const params = init?.method === "POST" && init.body instanceof URLSearchParams ? init.body : undefined
  const token = params?.get("grant_type") === "refresh_token" ? params.get("refresh_token") : null
  if (!token) return fetch(url, init)
  const key = `${String(url)} ${createHash("sha256").update(token).digest("hex")}`
  let shared = refreshes.get(key)
  if (!shared) {
    shared = fetch(url, init).then(async (res) => ({
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers],
      body: await res.text(),
    }))
    refreshes.set(key, shared)
    shared.then(
      () => setTimeout(() => refreshes.delete(key), REFRESH_REUSE_MS).unref(),
      () => refreshes.delete(key),
    )
  }
  return shared.then((r) => new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers }))
}

export function parseRedirectUri(redirectUri?: string): { port: number; path: string } {
  if (!redirectUri) {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }
  try {
    const url = new URL(redirectUri)
    const port = url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80
    const path = url.pathname || OAUTH_CALLBACK_PATH
    return { port, path }
  } catch {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }
}
