// Spike for #67 step 0: can the HOST sign in to a Keystone connection as its own OAuth client, the way
// the box does today? Proves dynamic registration with the loopback redirect, the token's audience and
// lifetime, refresh-token rotation, and an MCP tools/list with a bearer the host adds. Prints facts only,
// never a token or code. Run: bun spike/keystone-host-client-proof.ts [connection-id]  (default rag-read)
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CALLBACK_PATH, LOGIN_PORT, loopbackRedirect } from "../src/supervisor/login.ts"

const ORIGIN = process.env.OCD_KEYSTONE_ORIGIN ?? "https://identity.alterspective.com.au"
const id = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "rag-read"
if (!/^[a-z0-9-]{1,63}$/.test(id)) throw new Error("connection id must be lower-case letters, digits and '-'")
const resource = new URL(`${ORIGIN}/mcp/c/${id}`)
const redirect = loopbackRedirect(LOGIN_PORT)
const facts: Record<string, unknown> = { connection: id, resource: resource.href, redirect }
const report = (key: string, value: unknown) => {
  facts[key] = value
  console.error(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
}

/** JWT claims that say who and what a token is for. The signature part is never read or printed. */
function claims(token: string) {
  const part = token.split(".")[1]
  if (!part) return { jwt: false }
  const c = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>
  const life = typeof c.exp === "number" && typeof c.iat === "number" ? c.exp - c.iat : undefined
  return { jwt: true, iss: c.iss, aud: c.aud, scope: c.scope, lifetimeSeconds: life, hasSub: typeof c.sub === "string" }
}

async function mcpTools(bearer?: string) {
  const transport = new StreamableHTTPClientTransport(resource, bearer ? { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } } : {})
  const client = new Client({ name: "ocd-keystone-host-spike", version: "0.0.0" })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    return { ok: true, tools: tools.tools.length }
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 160) }
  } finally {
    await client.close().catch(() => {})
  }
}

// 1. Without a bearer the endpoint must refuse: front has to add it.
report("withoutBearer", await mcpTools())

// 2. Discovery, as the box's MCP client does it.
const prm = await discoverOAuthProtectedResourceMetadata(resource)
report("protectedResource", { resource: prm.resource, authorizationServers: prm.authorization_servers })
const issuer = new URL(prm.authorization_servers?.[0] ?? ORIGIN)
const metadata = await discoverAuthorizationServerMetadata(issuer)
if (!metadata) throw new Error("no authorization server metadata")
report("authorizationServer", { issuer: metadata.issuer, registration: Boolean(metadata.registration_endpoint), authMethods: metadata.token_endpoint_auth_methods_supported })
// Read-only so far: nothing registered, no browser.
if (process.argv.includes("--discover-only")) process.exit(0)

// 3. Dynamic registration as a NEW public client with the loopback redirect (the open question).
const clientInformation = await registerClient(issuer, {
  metadata,
  clientMetadata: { redirect_uris: [redirect], client_name: "OpenCode delegate host (spike)", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
})
report("registered", { clientIdPrefix: clientInformation.client_id.slice(0, 8), authMethod: clientInformation.token_endpoint_auth_method ?? "unspecified" })

// 4. Owner consent in the browser; the code comes back to the loopback listener.
const state = randomBytes(16).toString("hex")
const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, { metadata, clientInformation, redirectUrl: redirect, state, resource })
const code = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => (server.close(), reject(new Error("no sign-in within 5 minutes"))), 5 * 60_000)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", redirect)
    if (url.pathname !== CALLBACK_PATH) return void res.writeHead(404).end()
    const done = (status: number, text: string) => (res.writeHead(status, { "content-type": "text/plain" }).end(text), clearTimeout(timer), server.close())
    if (url.searchParams.get("state") !== state) return done(400, "state mismatch"), reject(new Error("state mismatch"))
    const error = url.searchParams.get("error")
    if (error) return done(400, "sign-in refused"), reject(new Error(`sign-in refused: ${error}`))
    done(200, "Signed in. You can close this tab.")
    resolve(url.searchParams.get("code") ?? "")
  })
  server.on("error", (error) => (clearTimeout(timer), reject(error)))
  server.listen(LOGIN_PORT, "127.0.0.1", () => {
    console.error(`Opening the browser for ${id}. Sign in and approve within 5 minutes.`)
    const [cmd, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", authorizationUrl.href]] : [process.platform === "darwin" ? "open" : "xdg-open", [authorizationUrl.href]]
    spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" }).unref()
  })
})
if (!code) throw new Error("callback had no code")

// 5. Token exchange: audience, lifetime, refresh token.
const tokens = await exchangeAuthorization(issuer, { metadata, clientInformation, authorizationCode: code, codeVerifier, redirectUri: redirect, resource })
report("token", { type: tokens.token_type, expiresIn: tokens.expires_in, hasRefresh: Boolean(tokens.refresh_token), scope: tokens.scope, claims: claims(tokens.access_token) })

// 6. A bearer the host adds is all the MCP endpoint needs.
report("withBearer", await mcpTools(tokens.access_token))

// 7. Refresh: does the refresh token rotate, and is the old one refused afterwards?
if (tokens.refresh_token) {
  const refreshed = await refreshAuthorization(issuer, { metadata, clientInformation, refreshToken: tokens.refresh_token, resource })
  report("refresh", { expiresIn: refreshed.expires_in, rotated: Boolean(refreshed.refresh_token) && refreshed.refresh_token !== tokens.refresh_token, claims: claims(refreshed.access_token) })
  report("afterRefresh", await mcpTools(refreshed.access_token))
  const reuse = await refreshAuthorization(issuer, { metadata, clientInformation, refreshToken: tokens.refresh_token, resource }).then(
    () => "accepted",
    (error) => `refused: ${String(error).slice(0, 120)}`,
  )
  report("oldRefreshReused", reuse)
}

console.error(`\nDone. Revoke this spike client afterwards by its id (prefix ${clientInformation.client_id.slice(0, 8)}).`)
console.log(JSON.stringify(facts, null, 2))
