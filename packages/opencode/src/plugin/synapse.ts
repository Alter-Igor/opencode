import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createServer } from "http"
import open from "open"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

export const KEYSTONE_ISSUER = "https://identity.alterspective.com.au"
export const KEYSTONE_REGISTER = `${KEYSTONE_ISSUER}/api/oauth/register`
export const KEYSTONE_AUTHORIZE = `${KEYSTONE_ISSUER}/api/oauth/authorize`
export const KEYSTONE_TOKEN = `${KEYSTONE_ISSUER}/api/oidc/token`
export const SYNAPSE_DEFAULT_INFERENCE_URL = "https://synapse2-api.alterspective.com.au/v1"
export const SYNAPSE_AUDIENCE = "synapse"
export const OAUTH_SCOPES = "openid profile email synapse:models:read synapse:inference:invoke"
export const OAUTH_PORT = 1459
export const OAUTH_REDIRECT_PATH = "/auth/callback"
export const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000

export interface PkceCodes {
  verifier: string
  challenge: string
}

export async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(64)
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64UrlEncode(hash) }
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map((b) => chars[b % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(buffer))
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

export function redirectUri(port = OAUTH_PORT): string {
  return `http://127.0.0.1:${port}${OAUTH_REDIRECT_PATH}`
}

export function parseJwtPayload(token: string): Record<string, unknown> | undefined {
  if (!token || typeof token !== "string") return undefined
  const parts = token.split(".")
  if (parts.length < 2) return undefined
  try {
    const raw = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const padded = raw.padEnd(raw.length + ((4 - (raw.length % 4)) % 4), "=")
    const json = atob(padded)
    const parsed = JSON.parse(json)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export function accessTokenIsExpiring(token: string | undefined, skewMs = ACCESS_TOKEN_REFRESH_SKEW_MS): boolean {
  if (!token) return false
  const payload = parseJwtPayload(token)
  if (!payload || typeof payload.exp !== "number") return false
  const expMs = payload.exp * 1000
  const effectiveSkew = Math.max(0, skewMs)
  return expMs <= Date.now() + effectiveSkew
}

export async function registerKeystoneClient(
  redirect: string,
  fetcher: typeof fetch = fetch,
  registerUrl = KEYSTONE_REGISTER,
): Promise<{ clientId: string }> {
  const loopbackHosts = ["127.0.0.1", "localhost"]
  const url = new URL(redirect)
  const redirectUris = loopbackHosts.map((host) => {
    const next = new URL(redirect)
    next.hostname = host
    return next.toString()
  })

  const response = await fetcher(registerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "OpenCode Synapse Auth",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: OAUTH_SCOPES,
    }),
  })
  const body = (await response.json().catch(() => ({}))) as { client_id?: string; error?: string }
  if (!response.ok || !body.client_id) {
    throw new Error(`Keystone client registration failed (${response.status})`)
  }
  return { clientId: body.client_id }
}

export function buildAuthorizeUrl(
  input: {
    clientId: string
    redirectUri: string
    pkce: PkceCodes
    state: string
    authorizeUrl?: string
    scope?: string
    audience?: string
  },
): string {
  const endpoint = input.authorizeUrl || KEYSTONE_AUTHORIZE
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    audience: input.audience || SYNAPSE_AUDIENCE,
    scope: input.scope || OAUTH_SCOPES,
    code_challenge: input.pkce.challenge,
    code_challenge_method: "S256",
    state: input.state,
  })
  return `${endpoint}?${params.toString()}`
}

export async function exchangeCodeForTokens(
  input: {
    clientId: string
    code: string
    redirectUri: string
    verifier: string
    tokenUrl?: string
    audience?: string
  },
  fetcher: typeof fetch = fetch,
): Promise<{
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}> {
  const endpoint = input.tokenUrl || KEYSTONE_TOKEN
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": `opencode/${InstallationVersion}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
      audience: input.audience || SYNAPSE_AUDIENCE,
    }),
  })
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    error?: string
  }
  if (!response.ok || !body.access_token) {
    throw new Error(`Keystone token exchange failed (${response.status}): ${body.error || "unknown"}`)
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_in: body.expires_in ?? 3600,
    scope: body.scope,
  }
}

export async function refreshKeystoneToken(
  input: {
    clientId: string
    refreshToken: string
    tokenUrl?: string
    audience?: string
  },
  fetcher: typeof fetch = fetch,
): Promise<{
  access_token: string
  refresh_token?: string
  expires_in?: number
}> {
  const endpoint = input.tokenUrl || KEYSTONE_TOKEN
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": `opencode/${InstallationVersion}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      audience: input.audience || SYNAPSE_AUDIENCE,
    }),
  })
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!response.ok || !body.access_token) {
    throw new Error(`Keystone token refresh failed (${response.status})`)
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_in: body.expires_in,
  }
}

interface SynapsePluginOptions {
  authorizeUrl?: string
  tokenUrl?: string
  registerUrl?: string
  inferenceUrl?: string
  audience?: string
}

export async function SynapseAuthPlugin(input: PluginInput, options?: SynapsePluginOptions): Promise<Hooks> {
  const inferenceUrl = options?.inferenceUrl || process.env.SYNAPSE_BASE_URL || SYNAPSE_DEFAULT_INFERENCE_URL
  const audience = options?.audience || SYNAPSE_AUDIENCE

  return {
    auth: {
      provider: "synapse",
      loader: async (getAuth) => {
        const authData = await getAuth()
        if (!authData) {
          return {
            baseURL: inferenceUrl,
            headers: {
              "x-task-type": "code",
            },
          }
        }

        if (authData.type === "api") {
          return {
            apiKey: authData.key,
            baseURL: inferenceUrl,
            headers: {
              "x-task-type": "code",
            },
          }
        }

        if (authData.type === "oauth") {
          let accessToken = authData.access
          const refreshToken = authData.refresh
          const clientId = (authData as any).metadata?.clientId || (authData as any).clientId

          if (accessTokenIsExpiring(accessToken) && refreshToken && clientId) {
            try {
              const refreshed = await refreshKeystoneToken({
                clientId,
                refreshToken,
                tokenUrl: options?.tokenUrl,
                audience,
              })
              accessToken = refreshed.access_token
              const newRefresh = refreshed.refresh_token || refreshToken
              const expiresMs = refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : authData.expires

              await input.client.auth
                .set({
                  path: { id: "synapse" },
                  body: {
                    type: "oauth",
                    access: accessToken,
                    refresh: newRefresh,
                    expires: expiresMs,
                    enterpriseUrl: inferenceUrl,
                  },
                })
                .catch(() => {})
            } catch {
              // Best effort refresh; fallback to existing token
            }
          }

          return {
            apiKey: accessToken,
            baseURL: inferenceUrl,
            headers: {
              "x-task-type": "code",
            },
          }
        }

        return {
          baseURL: inferenceUrl,
          headers: {
            "x-task-type": "code",
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Sign in with Keystone (Alterspective SSO)",
          async authorize() {
            const pkce = await generatePKCE()
            const state = generateState()
            const redirect = redirectUri(OAUTH_PORT)

            let clientId = ""
            try {
              const reg = await registerKeystoneClient(redirect, fetch, options?.registerUrl)
              clientId = reg.clientId
            } catch {
              clientId = "ai-office-cli"
            }

            const url = buildAuthorizeUrl({
              clientId,
              redirectUri: redirect,
              pkce,
              state,
              authorizeUrl: options?.authorizeUrl,
              audience,
            })

            let server: ReturnType<typeof createServer> | undefined
            const callbackPromise = new Promise<{ code: string }>((resolve, reject) => {
              server = createServer((req, res) => {
                const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${OAUTH_PORT}`)
                if (reqUrl.pathname === OAUTH_REDIRECT_PATH) {
                  const queryCode = reqUrl.searchParams.get("code")
                  const queryState = reqUrl.searchParams.get("state")

                  if (queryState !== state) {
                    res.writeHead(400, { "Content-Type": "text/html" })
                    res.end("<h1>State mismatch</h1><p>Please try logging in again.</p>")
                    reject(new Error("OAuth state mismatch"))
                    return
                  }

                  if (!queryCode) {
                    res.writeHead(400, { "Content-Type": "text/html" })
                    res.end("<h1>Missing authorization code</h1>")
                    reject(new Error("Missing authorization code"))
                    return
                  }

                  res.writeHead(200, { "Content-Type": "text/html" })
                  res.end(
                    OauthCallbackPage.bootstrap({
                      tokenPath: "/auth/token",
                      provider: "Keystone (Synapse)",
                    }),
                  )
                  resolve({ code: queryCode })
                }
              })

              server.listen(OAUTH_PORT, "127.0.0.1")
            })

            await open(url).catch(() => undefined)

            return {
              url,
              instructions: "Sign in with your Alterspective account in the browser.",
              method: "auto" as const,
              async callback() {
                try {
                  const { code } = await callbackPromise
                  const tokens = await exchangeCodeForTokens({
                    clientId,
                    code,
                    redirectUri: redirect,
                    verifier: pkce.verifier,
                    tokenUrl: options?.tokenUrl,
                    audience,
                  })

                  return {
                    type: "success" as const,
                    provider: "synapse",
                    key: tokens.access_token,
                    metadata: {
                      clientId,
                      refreshToken: tokens.refresh_token || "",
                      expiresAt: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
                    },
                  }
                } catch (err) {
                  return { type: "failed" as const }
                } finally {
                  server?.close()
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "Paste Synapse API Key",
        },
      ],
    },
  }
}
