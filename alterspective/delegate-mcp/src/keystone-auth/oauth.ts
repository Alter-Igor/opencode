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
  parseErrorResponse,
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
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js"
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
  // RFC 8414 section 3.3: the issuer in the metadata must be the one it was discovered from. Only a
  // trailing slash is ignored (new URL() adds one to a bare origin).
  if (metadata.issuer.replace(/\/$/, "") !== issuer.href.replace(/\/$/, ""))
    throw new DelegateError("policy_violation", "Keystone's metadata names another issuer; nothing was sent there.", "Check keystoneOrigin and Keystone's discovery metadata.", "issuer mismatch")
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

/**
 * What one token reply gave the host. The refresh token is read from the RAW JSON before anything
 * else is checked, so a rotated token is never lost to a later check (review cycle 1, HIGH and M3):
 * the caller saves it first, and an unusable access token only means "saved, not published".
 */
export type TokenReply = {
  /** The refresh token in the reply, or undefined when it holds none. */
  refreshToken: string | undefined
  /** The access token and its lifetime, or why it cannot be used (it is then never published). */
  access: { accessToken: string; expiresInSec: number } | { unusable: string }
}

/**
 * Lifetime assumed when a reply has no usable `expires_in`: one hour, the Synapse default and the
 * lifetime the step 0 spike observed. A JWT's own `exp` still caps it.
 */
export const DEFAULT_LIFETIME_SEC = 3600

/**
 * Read a successful token reply without a schema that could reject it as a whole.
 *
 * @param text the raw response body
 * @param now host clock, epoch ms
 * @returns the refresh token (if any) and the access token or why it is unusable
 * @throws never
 * @example readTokenReply('{"access_token":"...","refresh_token":"..."}', Date.now())
 */
export function readTokenReply(text: string, now: number): TokenReply {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  const refreshToken = typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : undefined
  const unusable = (why: string): TokenReply => ({ refreshToken, access: { unusable: why } })
  const access = body.access_token
  if (typeof access !== "string" || access === "") return unusable("no access token")
  if (typeof body.token_type === "string" && body.token_type.toLowerCase() !== "bearer") return unusable("not a bearer token")
  const expiresIn = Number(body.expires_in)
  // min(expires_in or the default, the JWT's own exp) (as for Synapse, review L4). A host clock far
  // ahead of Keystone's makes the JWT look expired: that is "unusable", never a lost refresh token.
  const exp = jwtClaims(access)?.exp
  const life = Math.floor(Math.min(Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_LIFETIME_SEC, typeof exp === "number" ? exp - now / 1000 : Number.POSITIVE_INFINITY))
  if (life < MIN_LIFETIME_SEC) return unusable("lifetime too short")
  return { refreshToken, access: { accessToken: access, expiresInSec: life } }
}

/**
 * POST to the token endpoint ourselves instead of the SDK's exchange/refresh helpers: those parse
 * the reply with a strict schema, and a reply failing it would throw away a refresh token Keystone
 * has already rotated. Public client: client_id in the body, no secret (as the SDK does for "none").
 * Residual risk (cannot be fixed on the client): if the connection drops while the body is read,
 * or a 200 reply is not JSON at all, a rotated token cannot be read and is lost; the next refresh
 * then gets invalid_grant and the connection needs a sign-in.
 */
async function tokenRequest(fetchFn: FetchLike, server: KeystoneServer, params: URLSearchParams, now: number): Promise<TokenReply> {
  params.set("resource", server.resource.href)
  const response = await fetchFn(server.metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: params,
    // A 307/308 keeps method and body: following it would re-send the refresh token (or the code
    // and verifier) to whatever Location says. Refuse any redirect; it surfaces as a passing failure.
    redirect: "error",
  })
  const text = await response.text()
  // An error reply carries no token. parseErrorResponse maps it to the SDK's OAuthError classes;
  // its message can hold the raw body, so classify() only ever reads the error code.
  if (!response.ok) throw await parseErrorResponse(text)
  return readTokenReply(text, now)
}

/**
 * Exchange the authorization code (public client: no secret, PKCE verifier instead).
 *
 * @param fetchFn fetch
 * @param server result of discoverKeystone
 * @param clientId registered public client id
 * @param code authorization code from the callback
 * @param codeVerifier PKCE verifier from authorizationUrl
 * @param redirect the redirect URI used in the authorization request
 * @param now host clock, epoch ms
 * @returns the token reply (save its refresh token before using its access token)
 * @throws the SDK's OAuthError for an error reply, or a network/timeout error
 * @example const reply = await exchangeCode(fetch, server, clientId, code, verifier, redirect, Date.now())
 */
export function exchangeCode(fetchFn: FetchLike, server: KeystoneServer, clientId: string, code: string, codeVerifier: string, redirect: string, now: number): Promise<TokenReply> {
  return tokenRequest(fetchFn, server, new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: redirect, client_id: clientId }), now)
}

/**
 * Refresh. Keystone rotates strictly: once this call reaches Keystone, `refreshToken` is spent, so
 * the caller must save the returned one before anything else can fail.
 *
 * @param fetchFn fetch
 * @param server result of discoverKeystone
 * @param clientId registered public client id
 * @param refreshToken the stored refresh token (spent by this call)
 * @param now host clock, epoch ms
 * @returns the token reply; its refreshToken is the rotated one, or undefined if none came back
 * @throws the SDK's OAuthError for an error reply (e.g. InvalidGrantError), or a network/timeout error
 * @example const reply = await refreshTokens(fetch, server, clientId, stored, Date.now())
 */
export function refreshTokens(fetchFn: FetchLike, server: KeystoneServer, clientId: string, refreshToken: string, now: number): Promise<TokenReply> {
  return tokenRequest(fetchFn, server, new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }), now)
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
