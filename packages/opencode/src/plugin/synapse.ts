import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createServer } from "http"
import open from "open"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { sessionObserver } from "./observer"

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

export interface SynapseServingTelemetry {
  model: string
  provider?: string
  costUsd?: string
  latencyMs?: string
  timestamp: number
}

let latestSynapseServing: SynapseServingTelemetry | undefined

export function getLatestSynapseServing(): SynapseServingTelemetry | undefined {
  return latestSynapseServing
}

export function setLatestSynapseServing(telemetry: SynapseServingTelemetry | undefined): void {
  latestSynapseServing = telemetry
}

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
  let refreshPromise: Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> | undefined

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
          return {
            apiKey: "oauth-synapse-bearer",
            baseURL: inferenceUrl,
            async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
              let currentAuth = await getAuth()
              if (currentAuth.type !== "oauth") return fetch(requestInput, init)

              const clientId = (currentAuth as any).metadata?.clientId || (currentAuth as any).clientId || "ai-office-cli"
              const refreshToken = currentAuth.refresh
              const isExpiring =
                !currentAuth.expires ||
                currentAuth.expires - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS ||
                accessTokenIsExpiring(currentAuth.access)

              if (isExpiring && refreshToken) {
                if (!refreshPromise) {
                  refreshPromise = refreshKeystoneToken({
                    clientId,
                    refreshToken,
                    tokenUrl: options?.tokenUrl,
                    audience,
                  })
                    .then(async (tokens) => {
                      const refreshedExpires = Date.now() + (tokens.expires_in ?? 3600) * 1000
                      const refreshedRefresh = tokens.refresh_token || refreshToken
                      await input.client.auth
                        .set({
                          path: { id: "synapse" },
                          body: {
                            type: "oauth",
                            access: tokens.access_token,
                            refresh: refreshedRefresh,
                            expires: refreshedExpires,
                            enterpriseUrl: inferenceUrl,
                          },
                        })
                        .catch(() => {})
                      return tokens
                    })
                    .finally(() => {
                      refreshPromise = undefined
                    })
                }

                try {
                  const refreshed = await refreshPromise
                  currentAuth = {
                    ...currentAuth,
                    access: refreshed.access_token,
                    refresh: refreshed.refresh_token || refreshToken,
                    expires: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
                  }
                } catch {
                  // If refresh fails, fall back to current token
                }
              }

              const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
              if (init?.headers) {
                const entries =
                  init.headers instanceof Headers
                    ? init.headers.entries()
                    : Array.isArray(init.headers)
                      ? init.headers
                      : Object.entries(init.headers as Record<string, string | undefined>)
                for (const [key, value] of entries) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }

              headers.set("authorization", `Bearer ${currentAuth.access}`)
              headers.set("x-task-type", "code")
              headers.set("User-Agent", `opencode/${InstallationVersion}`)

              const response = await fetch(requestInput, { ...init, headers })
              const servedModel = response.headers.get("x-synapse-served-model")
              const costUsd = response.headers.get("x-synapse-cost-usd")
              const routedProvider = response.headers.get("x-synapse-routed-provider")
              const latencyMs = response.headers.get("x-synapse-latency-ms")

              if (servedModel) {
                latestSynapseServing = {
                  model: servedModel,
                  provider: routedProvider ?? undefined,
                  costUsd: costUsd ?? undefined,
                  latencyMs: latencyMs ?? undefined,
                  timestamp: Date.now(),
                }
              }

              return response
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
    event: async ({ event }) => {
      if (event.type === "session.idle" || event.type === "session.deleted") {
        const sessionID = (event.properties as any)?.sessionID || (event.properties as any)?.id
        if (sessionID) {
          await sessionObserver.finalizeSessionRetrospective(sessionID, input.directory)
        }
      }
    },
    "tool.execute.before": async (toolInput, output) => {
      // 1. Policy Enforcement: Block raw browser scraping of corporate email / M365
      if (toolInput.tool.includes("playwright") || toolInput.tool.includes("browser")) {
        const url = String(output.args?.url || output.args?.Url || "").toLowerCase()
        const blocked = [
          "outlook.office.com",
          "outlook.live.com",
          "login.microsoftonline.com",
          "teams.microsoft.com",
          "sharepoint.com",
        ]
        if (blocked.some((domain) => url.includes(domain))) {
          throw new Error(
            `[SECURITY & COMPLIANCE GATE] Direct browser automation to corporate service '${url}' is blocked. Corporate data access must go through the audited 'keystone-dynamic' MCP gateway (use search-tools -> get-tool-schema -> execute-tool).`,
          )
        }
      }

      // 2. Keystone Dynamic Tool Name Normalization
      if (
        (toolInput.tool.includes("execute-tool") || toolInput.tool.includes("execute_tool")) &&
        output.args?.toolName
      ) {
        let name = String(output.args.toolName).trim()
        name = name.replace(/^(mcp__)?keystone[-_]dynamic[-_]/i, "")
        if (name === "search_tools" || name === "searchTools" || name === "search") {
          name = "search-tools"
        } else if (name === "get_tool_schema" || name === "getToolSchema" || name === "schema") {
          name = "get-tool-schema"
        }
        output.args.toolName = name
      }

      sessionObserver.onToolBefore(toolInput.sessionID, toolInput.callID, toolInput.tool, output.args)
    },
    "tool.execute.after": async (toolInput, output) => {
      sessionObserver.onToolAfter(toolInput.sessionID, toolInput.callID, toolInput.tool, output.output)
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        [
          "## Mandatory Keystone Dynamic MCP Gateway Instructions",
          "All corporate MCP tools (Microsoft 365 Email/Calendar/Teams, Keystone Admin, RAG, CRM, etc.) are centralized in `keystone-dynamic`.",
          "To access corporate tools:",
          "1. SEARCH: Call `keystone-dynamic_search-tools` with `{\"query\": \"mail\"}` or `{\"query\": \"email\"}` or `{\"query\": \"calendar\"}`.",
          "2. SCHEMA: Call `keystone-dynamic_get-tool-schema` with `{\"toolName\": \"<exact_name_from_search>\"}`.",
          "3. EXECUTE: Call `keystone-dynamic_execute-tool` with `{\"toolName\": \"<exact_name>\", \"arguments\": { ... }}`.",
          "- STRICT RULE: Do NOT guess tool names (e.g. `m365__list-emails` is invalid). Always search first with `search-tools`.",
          "- STRICT SECURITY GATE: NEVER use Playwright / browser tools to navigate to `outlook.office.com`, `login.microsoftonline.com`, or other corporate web apps. All corporate operations MUST use Keystone to maintain audit compliance.",
        ].join("\n"),
      )
    },
    tool: {
      synapse_probe: {
        description: "Check the last Synapse AI model routing, provider destination, and inference cost telemetry.",
        args: {},
        async execute() {
          if (!latestSynapseServing) {
            return "Synapse is connected. No inference requests have completed in this session yet."
          }
          const costText = latestSynapseServing.costUsd ? ` | Cost: $${latestSynapseServing.costUsd}` : ""
          const providerText = latestSynapseServing.provider ? ` via ${latestSynapseServing.provider}` : ""
          const latencyText = latestSynapseServing.latencyMs ? ` (${latestSynapseServing.latencyMs}ms)` : ""
          return `Active Synapse Model: ${latestSynapseServing.model}${providerText}${latencyText}${costText}`
        },
      },
      session_retrospective_summary: {
        description: "Retrieve recent session retrospectives, learning points, and compliance/audit bypass warnings.",
        args: {},
        async execute() {
          const retros = sessionObserver.getLatestRetrospectives()
          if (retros.length === 0) {
            return "No session retrospectives have completed yet."
          }
          return JSON.stringify(retros.slice(0, 5), null, 2)
        },
      },
    },
  }
}
