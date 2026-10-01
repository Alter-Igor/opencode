// WS2 (#48): the Keystone calls the host bridge makes for the owner's delegated Synapse token.
// Request shapes are ported from the fork plugin (packages/opencode/src/plugin/synapse.ts:
// buildHandoffLoginUrl, exchangeHandoffForSynapseToken with offline:true, refreshKeystoneToken),
// so Keystone sees exactly what it already accepts from app `opencode`:
// - handoff sign-in: GET <origin>/api/auth/login?app=opencode&redirect_uri=...&nonce=...&returnTo=/
// - exchange (RFC 8693): POST /api/oidc/token, Bearer <broker key>, audience=synapse, scope=offline_access.
//   The broker key holds credentials:broker, so Keystone stamps act: service:opencode.
// - refresh: POST /api/oidc/token, grant_type=refresh_token, client_id=opencode + client secret.
// Errors carry the HTTP status and Keystone's error code only, never a token or a key.
import { DelegateError } from "../shared/errors.ts"
import { JWT_RE } from "./auth-conf.ts"

export const HANDOFF_APP_ID = "opencode"
export const SYNAPSE_AUDIENCE = "synapse"
/** The callback registered on the production `opencode` app (same as the fork plugin). */
export const SYNAPSE_LOGIN_PORT = 1459
export const SYNAPSE_CALLBACK_PATH = "/auth/callback"
export const TOKEN_PATH = "/api/oidc/token"
export const LOGIN_PATH = "/api/auth/login"
const ERROR_CODE = /^[a-z_]{1,64}$/

export type TokenSet = { accessToken: string; refreshToken?: string; expiresInSec: number }
export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export const synapseRedirectUri = (port = SYNAPSE_LOGIN_PORT) => `http://127.0.0.1:${port}${SYNAPSE_CALLBACK_PATH}`

export function handoffLoginUrl(origin: string, redirectUri: string, nonce: string): string {
  const params = new URLSearchParams({ app: HANDOFF_APP_ID, redirect_uri: redirectUri, nonce, returnTo: "/" })
  return `${origin}${LOGIN_PATH}?${params.toString()}`
}

/** RFC 8693: the handoff JWT for a `synapse` token plus a refresh token (offline_access). */
export function exchangeHandoff(fetcher: Fetch, origin: string, handoff: string, brokerKey: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    subject_token: handoff,
    audience: SYNAPSE_AUDIENCE,
    scope: "offline_access",
  })
  return tokenCall(fetcher, origin, body, { Authorization: `Bearer ${brokerKey}` }, "exchange")
}

/** A new `synapse` token from the stored refresh token (client `opencode` + its secret). */
export function refreshSynapse(fetcher: Fetch, origin: string, refreshToken: string, clientSecret: string): Promise<TokenSet> {
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: HANDOFF_APP_ID, refresh_token: refreshToken, audience: SYNAPSE_AUDIENCE })
  if (clientSecret) body.set("client_secret", clientSecret)
  return tokenCall(fetcher, origin, body, {}, "refresh")
}

async function tokenCall(fetcher: Fetch, origin: string, body: URLSearchParams, auth: Record<string, string>, step: string): Promise<TokenSet> {
  const response = await fetcher(`${origin}${TOKEN_PATH}`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": "opencode-delegate", ...auth },
    body,
  }).catch(() => undefined)
  if (!response) throw new DelegateError("upstream_error", `Keystone could not be reached for the Synapse token ${step}.`, "Check the network, then retry.", `${step}: fetch failed`)
  const json = (await response.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown }
  const code = typeof json.error === "string" && ERROR_CODE.test(json.error) ? json.error : "unknown"
  if (!response.ok || typeof json.access_token !== "string") throw tokenError(step, response.status, code)
  if (!JWT_RE.test(json.access_token)) throw new DelegateError("upstream_error", "Keystone returned a Synapse token the bridge does not recognise.", "Run oc_login {server: \"synapse\"} again.", `${step}: token shape`)
  const expires = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600
  return { accessToken: json.access_token, ...(typeof json.refresh_token === "string" && json.refresh_token ? { refreshToken: json.refresh_token } : {}), expiresInSec: expires }
}

function tokenError(step: string, status: number, code: string): DelegateError {
  // 400/401 on refresh: the refresh token was revoked or expired, or the Synapse role removed.
  if (status === 400 || status === 401 || status === 403)
    return new DelegateError("needs_auth", `Keystone refused the Synapse token ${step} (HTTP ${status}, ${code}).`, "Run oc_login {server: \"synapse\"} to sign in again. If it repeats, check the owner holds a Synapse role and app opencode holds credentials:broker.", `${step}: HTTP ${status} ${code}`)
  return new DelegateError("upstream_error", `Keystone failed the Synapse token ${step} (HTTP ${status}).`, "Retry later; run oc_doctor.", `${step}: HTTP ${status} ${code}`)
}
