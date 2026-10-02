// #67 step 1: the host's OAuth calls to Keystone for one connection, through the MCP SDK (the same
// calls the step 0 spike proved live): discovery, dynamic registration as a PUBLIC client, the
// authorization URL with PKCE, the code exchange and the refresh.
// Facts from the spike that shape this file:
// - resource = <origin>/mcp/c/<id>; the token is audience-bound to it.
// - scope MUST come from the protected resource's `scopes_supported` (today `mcp:connection`), for
//   registration AND authorize, or Keystone answers invalid_scope.
// - Every endpoint must be on the configured Keystone origin: the refresh token is only ever sent
//   there, whatever a metadata document says.
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js"
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  OAuthError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js"
import type { AuthorizationServerMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { jwtClaims } from "../synapse/keystone-token.ts"
import { assertConnectionId } from "./state.ts"

/** The SDK's fetch shape (shared/transport FetchLike). */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

export const KEYSTONE_TIMEOUT_MS = 30_000
/** A token that lives less than this is treated as a failed call (as for Synapse). */
export const MIN_LIFETIME_SEC = 60
export const CLIENT_NAME = "OpenCode delegate host"

export type KeystoneServer = {
  connection: string
  resource: URL
  issuer: URL
  metadata: AuthorizationServerMetadata
  /** Space-separated `scopes_supported` of the protected resource, or undefined when it names none. */
  scope: string | undefined
}

export type HostTokens = { accessToken: string; refreshToken: string | undefined; expiresInSec: number }

/** Every call gets a timeout, so a hung Keystone is a passing failure, not a stuck tick. */
export const withTimeout = (fetchFn: FetchLike, ms = KEYSTONE_TIMEOUT_MS): FetchLike => (url, init) => fetchFn(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(ms) })

function keystoneOrigin(origin: string): URL {
  const url = new URL(origin)
  // A refresh token over plain HTTP could be read on the way; Keystone is always HTTPS.
  if (url.protocol !== "https:") throw new DelegateError("invalid_input", "The Keystone origin must be https.", "Fix keystoneOrigin in the bridge config.")
  return url
}

function sameOrigin(expected: URL, value: string | URL | undefined, what: string): void {
  if (value === undefined) return
  if (new URL(String(value)).origin !== expected.origin)
    throw new DelegateError("policy_violation", `Keystone's ${what} is not on the Keystone origin; nothing was sent there.`, "Check keystoneOrigin and Keystone's discovery metadata.", `${what} on another origin`)
}

/**
 * Discover the connection's protected resource and its authorization server, and check that both,
 * and every endpoint the host will call or open, are on the Keystone origin.
 *
 * @param fetchFn fetch (tests inject a fake Keystone)
 * @param origin configured Keystone origin (https)
 * @param connectionId Keystone connection id
 * @returns the resource, issuer, metadata and the scope to ask for
 * @throws DelegateError policy_violation (another origin), invalid_input (bad id/origin), or the SDK's error
 * @example const server = await discoverKeystone(fetch, "https://identity.example", "rag-read")
 */
export async function discoverKeystone(fetchFn: FetchLike, origin: string, connectionId: string): Promise<KeystoneServer> {
  const base = keystoneOrigin(origin)
  const resource = new URL(`${base.origin}/mcp/c/${assertConnectionId(connectionId)}`)
  const prm = await discoverOAuthProtectedResourceMetadata(resource, undefined, fetchFn)
  if (new URL(prm.resource).href !== resource.href)
    throw new DelegateError("policy_violation", "Keystone's protected-resource metadata names another resource.", "Check the connection id.", "resource mismatch")
  const issuer = new URL(prm.authorization_servers?.[0] ?? base.origin)
  sameOrigin(base, issuer, "authorization server")
  const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn })
  if (!metadata) throw new DelegateError("upstream_error", "Keystone published no authorization server metadata.", "Retry later; run oc_doctor.", "no AS metadata")
  sameOrigin(base, metadata.issuer, "issuer")
  sameOrigin(base, metadata.authorization_endpoint, "authorization endpoint")
  sameOrigin(base, metadata.token_endpoint, "token endpoint")
  sameOrigin(base, metadata.registration_endpoint, "registration endpoint")
  const scopes = prm.scopes_supported?.filter((s) => s !== "")
  return { connection: connectionId, resource, issuer, metadata, scope: scopes && scopes.length > 0 ? scopes.join(" ") : undefined }
}

/**
 * Register this host as a new PUBLIC client (token_endpoint_auth_method none) with the loopback
 * redirect and the resource's scope.
 *
 * @param fetchFn fetch
 * @param server result of discoverKeystone
 * @param redirect loopback redirect URI
 * @returns the new client id
 * @throws DelegateError upstream_error when Keystone hands back a confidential client
 * @example const clientId = await registerHostClient(fetch, server, loopbackRedirect(LOGIN_PORT))
 */
export async function registerHostClient(fetchFn: FetchLike, server: KeystoneServer, redirect: string): Promise<string> {
  const scope = server.scope
  const info = await registerClient(server.issuer, {
    metadata: server.metadata,
    clientMetadata: { redirect_uris: [redirect], client_name: CLIENT_NAME, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...(scope ? { scope } : {}) },
    ...(scope ? { scope } : {}),
    fetchFn,
  })
  // A client secret would need its own protected storage; a public client has none by design.
  if (info.client_secret !== undefined || (info.token_endpoint_auth_method ?? "none") !== "none")
    throw new DelegateError("upstream_error", "Keystone registered a confidential client; the host expects a public one.", "Check Keystone's dynamic client registration settings.", "registration: not a public client")
  return info.client_id
}

/**
 * The authorization URL the owner's browser opens (PKCE S256, state, scope, resource).
 *
 * @param server result of discoverKeystone
 * @param clientId registered client id
 * @param redirect loopback redirect URI
 * @param state random state checked on the callback
 * @returns the URL to open and the PKCE verifier (kept in memory only)
 * @throws when Keystone does not support the code flow with S256
 * @example const { url, codeVerifier } = await authorizationUrl(server, clientId, redirect, state)
 */
export async function authorizationUrl(server: KeystoneServer, clientId: string, redirect: string, state: string): Promise<{ url: URL; codeVerifier: string }> {
  const { authorizationUrl: url, codeVerifier } = await startAuthorization(server.issuer, {
    metadata: server.metadata,
    clientInformation: { client_id: clientId },
    redirectUrl: redirect,
    state,
    resource: server.resource,
    ...(server.scope ? { scope: server.scope } : {}),
  })
  sameOrigin(server.issuer, url, "authorization URL")
  return { url, codeVerifier }
}

function hostTokens(tokens: OAuthTokens, now: number): HostTokens {
  // min(expires_in, the JWT's own exp) when both exist (as for Synapse, review L4); either alone
  // when only one exists; neither means the lifetime is unknown, which is refused.
  const exp = jwtClaims(tokens.access_token)?.exp
  const bounds = [tokens.expires_in, typeof exp === "number" ? exp - now / 1000 : undefined].filter((v): v is number => typeof v === "number" && Number.isFinite(v))
  const life = bounds.length > 0 ? Math.floor(Math.min(...bounds)) : 0
  if (life < MIN_LIFETIME_SEC) throw new DelegateError("upstream_error", "Keystone returned a token with no usable lifetime.", "Retry later; run oc_doctor.", "token: lifetime too short")
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresInSec: life }
}

/**
 * Exchange the authorization code (public client: no secret, PKCE verifier instead).
 *
 * @returns the token set
 * @throws the SDK's OAuthError, or DelegateError for an unusable lifetime
 * @example const tokens = await exchangeCode(fetch, server, clientId, code, verifier, redirect, Date.now())
 */
export async function exchangeCode(fetchFn: FetchLike, server: KeystoneServer, clientId: string, code: string, codeVerifier: string, redirect: string, now: number): Promise<HostTokens> {
  const tokens = await exchangeAuthorization(server.issuer, { metadata: server.metadata, clientInformation: { client_id: clientId }, authorizationCode: code, codeVerifier, redirectUri: redirect, resource: server.resource, fetchFn })
  return hostTokens(tokens, now)
}

/**
 * Refresh. Keystone rotates strictly: once this call reaches Keystone, `refreshToken` is spent,
 * so the caller must keep the returned one before anything else can fail.
 *
 * @returns the new token set; `refreshToken` is the rotated one (or the old one if none was sent back)
 * @throws the SDK's OAuthError, a network/timeout error, or DelegateError for an unusable lifetime
 * @example const tokens = await refreshTokens(fetch, server, clientId, stored, Date.now())
 */
export async function refreshTokens(fetchFn: FetchLike, server: KeystoneServer, clientId: string, refreshToken: string, now: number): Promise<HostTokens> {
  const tokens = await refreshAuthorization(server.issuer, { metadata: server.metadata, clientInformation: { client_id: clientId }, refreshToken, resource: server.resource, fetchFn })
  return hostTokens(tokens, now)
}

/** OAuth answers after which retrying cannot help: the grant or the client is gone. */
const SIGN_IN_ERRORS = [InvalidGrantError, InvalidClientError, UnauthorizedClientError, InvalidScopeError, InvalidTargetError]
/** The client itself is gone or refused; the next sign-in must register a new one. */
const CLIENT_ERRORS = [InvalidClientError, UnauthorizedClientError]

export type Failure = { kind: "needs_sign_in" | "transient"; forgetClient: boolean; reason: string }

/**
 * Classify a failed Keystone call. The reason is a fixed step name plus an OAuth error code or an
 * error class name: never the error's message, which for a malformed answer carries the raw body.
 *
 * @param step short fixed name of the call (e.g. "refresh")
 * @param error what the call threw
 * @returns needs_sign_in (invalid_grant, revoked client, ...) or transient (network, 5xx, timeout)
 * @throws never
 * @example classify("refresh", error).kind === "needs_sign_in"
 */
export function classify(step: string, error: unknown): Failure {
  if (SIGN_IN_ERRORS.some((cls) => error instanceof cls)) {
    const code = (error as OAuthError).errorCode
    return { kind: "needs_sign_in", forgetClient: CLIENT_ERRORS.some((cls) => error instanceof cls), reason: `${step}: Keystone refused (${code})` }
  }
  if (error instanceof OAuthError) return { kind: "transient", forgetClient: false, reason: `${step}: ${error.errorCode}` }
  if (isDelegateError(error)) return { kind: error.code === "policy_violation" || error.code === "invalid_input" ? "needs_sign_in" : "transient", forgetClient: false, reason: `${step}: ${error.code}` }
  return { kind: "transient", forgetClient: false, reason: `${step}: ${error instanceof Error ? error.name : "error"}` }
}
