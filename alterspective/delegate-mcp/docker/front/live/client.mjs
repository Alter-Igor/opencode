// Runs INSIDE a sealed probe container (docker/front/live/probe.yaml): node:22-slim and the real
// box image (R4-04). Prints one JSON object. Arguments: the `sealed` network's gateway address, and
// the one Keystone connection id the live front was generated for besides github and seqlogs
// (test/egress-live.test.ts passes it explicitly, so the probes never drift from the default set).
// Every request is a public, read-only GET, an unauthenticated POST or a bare TCP connect. No real
// credential is ever sent: the one Authorization header below is a made-up JWT-shaped string.
import dns from "node:dns/promises"
import { readFileSync } from "node:fs"
import https from "node:https"
import net from "node:net"
import os from "node:os"
import tls from "node:tls"
import { randomBytes } from "node:crypto"

const CA = readFileSync("/etc/ocd-front-ca/ca.pem")
const IDENTITY = "identity.alterspective.com.au"
const SYNAPSE = "synapse2-api.alterspective.com.au"
const T = 20_000
const GATEWAY = process.argv[2] ?? ""
/** The chosen RAG connection in the live front (review M2 of 90434eaaf5: explicit, not the default). */
const CONN = process.argv[3] ?? "rag-read"
/** A made-up bearer the box might send itself; front must drop it (WS2 #48). Never a real token. */
const BOX_BEARER = "Bearer aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc"
/** Cloudflare's public DNS over IPv6: a public v6 address that answers on 443 when reachable. */
const PUBLIC_V6 = "2606:4700:4700::1111"
/** The Docker host side of `sealed` (R4-04): SSH, DNS, HTTP(S) and the Docker API ports. */
const GATEWAY_PORTS = [22, 53, 80, 443, 2375, 2376]

/** GET over front. `connectTo` is the name the socket goes to; `sni` and `host` can be swapped. */
// trust: "front" (front's CA only), "public" (Node's bundled roots only), "none" (no verification; red probes).
function get({ connectTo, sni, host, path, trust = "front" }) {
  return new Promise((resolve) => {
    const req = https.request(
      { host: connectTo, port: 443, servername: sni, path, method: "GET", headers: { host }, ca: trust === "front" ? CA : undefined, rejectUnauthorized: trust !== "none", timeout: T, agent: false },
      (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => (body.length < 4000 ? (body += chunk) : undefined))
        res.on("end", () => resolve({ status: res.statusCode, body: body.slice(0, 1500) }))
      },
    )
    req.on("timeout", () => req.destroy(new Error("timeout")))
    req.on("error", (error) => resolve({ error: error.code ?? "error", message: String(error.message).slice(0, 160) }))
    req.end()
  })
}

/** Raw bytes over TLS (for request forms https.request will not send), first line back. */
function rawTls({ connectTo, sni, payload, verify = true }) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: connectTo, port: 443, servername: sni, ca: CA, rejectUnauthorized: verify, timeout: T })
    let buffer = ""
    const done = (value) => (socket.destroy(), resolve(value))
    socket.on("secureConnect", () => socket.write(payload))
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1")
      if (buffer.includes("\r\n")) done(buffer.slice(0, buffer.indexOf("\r\n")))
    })
    socket.on("timeout", () => done("timeout"))
    socket.on("error", (error) => done(`error: ${error.code ?? "error"} ${String(error.message).slice(0, 120)}`))
    socket.on("end", () => done(buffer || "closed"))
  })
}

/**
 * R4-01: one request to Keystone through front, sent byte for byte (no client-side path clean-up),
 * with NO credentials. Returns the status and whether the answer is front's own error page (a
 * refusal that never reached Keystone).
 */
function keystoneRequest(method, target) {
  return rawRequest(IDENTITY, method, target)
}

/** The same raw request to any front host, with extra header lines; the body's first 300 characters too. */
function rawRequest(host, method, target, extra = []) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, ca: CA, timeout: T })
    const body = method === "POST" ? "{}" : ""
    const head = [
      `${method} ${target} HTTP/1.1`,
      `Host: ${host}`,
      "Accept: application/json, text/event-stream",
      ...(body ? ["Content-Type: application/json", `Content-Length: ${body.length}`] : []),
      ...extra,
      "Connection: close",
    ]
    let buffer = ""
    const done = (value) => (socket.destroy(), resolve(value))
    // nginx hides the upstream Server header, so a refusal is told apart by front's own error page.
    const parse = () => {
      const statusLine = buffer.slice(0, buffer.indexOf("\r\n"))
      const page = buffer.slice(buffer.indexOf("\r\n\r\n") + 4)
      return { status: Number(statusLine.split(" ")[1]), front: page.includes("<center>nginx</center>"), body: page.slice(0, 300) }
    }
    socket.on("secureConnect", () => socket.write(`${head.join("\r\n")}\r\n\r\n${body}`))
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1")
      if (buffer.length > 8000) done(parse())
    })
    socket.on("timeout", () => done({ error: "timeout" }))
    socket.on("error", (error) => done({ error: error.code ?? "error" }))
    socket.on("end", () => done(buffer.includes("\r\n\r\n") ? parse() : { error: "closed" }))
  })
}

/** R4-01 path probes: [name, method, request-target]. Chosen connection in the live front: CONN. */
const KEYSTONE_PATHS = [
  // Allowed (Keystone answers; no credentials, so the MCP endpoint says 401).
  ["discovery", "GET", "/.well-known/oauth-authorization-server"],
  ["resourceMetadata", "GET", `/.well-known/oauth-protected-resource/mcp/c/${CONN}`],
  ["mcpNoAuth", "POST", `/mcp/c/${CONN}`],
  // Spellings nginx normalises INTO the allowed path: forwarded as the literal allowed path.
  ["encodedAllowed", "POST", `/mcp/c/%${CONN.charCodeAt(0).toString(16)}${CONN.slice(1)}`],
  ["dotsIntoAllowed", "POST", `/mcp/dynamic/../c/${CONN}`],
  // Refused by front (403, never forwarded) or rejected by nginx itself (400).
  ["dynamicPost", "POST", "/mcp/dynamic"],
  ["dynamicGet", "GET", "/mcp/dynamic"],
  ["adminMcp", "POST", "/api/mcp"],
  ["otherConnection", "POST", "/mcp/c/m365"],
  ["dynamicMetadata", "GET", "/.well-known/oauth-protected-resource/mcp/dynamic"],
  ["traversal", "POST", `/mcp/c/${CONN}/../../dynamic`],
  ["encodedSlashTraversal", "POST", `/mcp/c/${CONN}%2F..%2F..%2Fdynamic`],
  ["encodedDots", "POST", "/mcp/c/%2e%2e/dynamic"],
  ["encodedDynamic", "POST", "/mcp/%64ynamic"],
  ["doubleSlashes", "POST", "//mcp//dynamic"],
  ["upperCase", "POST", "/MCP/DYNAMIC"],
  ["semicolon", "POST", `/mcp/c/${CONN};/../../dynamic`],
  ["queryString", "POST", `/mcp/c/${CONN}?x=1`],
  ["trailingSlash", "POST", `/mcp/c/${CONN}/`],
  // Not chosen in the live front: the read-write RAG connection.
  ["ragGlobal", "POST", "/mcp/c/rag-global"],
  ["tokenWrongMethod", "GET", "/api/oidc/token"],
  ["authorize", "GET", "/api/oauth/authorize"],
  ["otherApi", "GET", "/api/users/me"],
  ["nul", "POST", `/mcp/c/${CONN}%00`],
  ["absoluteForm", "POST", `https://${IDENTITY}/mcp/dynamic`],
]

async function keystonePaths() {
  const out = {}
  for (const [name, method, target] of KEYSTONE_PATHS) out[name] = await keystoneRequest(method, target)
  return out
}

/** Plain TCP: did it connect, and what came back to `payload` (if any). */
function rawTcp(host, port, payload) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 5_000 })
    let buffer = ""
    const done = (value) => (socket.destroy(), resolve(value))
    socket.on("connect", () => (payload ? socket.write(payload) : done("connected")))
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1")
      if (buffer.includes("\r\n")) done(buffer.slice(0, buffer.indexOf("\r\n")))
    })
    socket.on("timeout", () => done("timeout"))
    socket.on("error", (error) => done(`error: ${error.code ?? "error"} ${String(error.message).slice(0, 120)}`))
    socket.on("end", () => done(buffer || "closed"))
  })
}

async function resolves(name) {
  try {
    return (await dns.lookup(name, { all: true })).map((a) => a.address)
  } catch {
    return []
  }
}

/** IPv6 answers only: getaddrinfo for AF_INET6, and a raw AAAA query to Docker's DNS. */
async function v6(name) {
  const lookup = await dns.lookup(name, { all: true, family: 6 }).then((all) => all.map((a) => a.address), () => [])
  const aaaa = await dns.resolve6(name).catch(() => [])
  return { lookup, aaaa }
}

/** Global IPv6 addresses on this container's interfaces (loopback and link-local left out). */
const globalV6 = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv6" && !a.internal && !a.address.toLowerCase().startsWith("fe80"))
    .map((a) => a.address)

async function gatewayPorts() {
  if (!GATEWAY) return { none: "no gateway address given" }
  const out = {}
  for (const port of GATEWAY_PORTS) out[port] = await rawTcp(GATEWAY, port)
  return out
}

const frontIp = (await resolves(IDENTITY))[0] ?? "none"
const result = {
  frontIp,
  dns: {
    identity: await resolves(IDENTITY),
    synapse: await resolves(SYNAPSE),
    cloudflare: await resolves("www.cloudflare.com"),
    vaultMcp: await resolves("vault-mcp.alterspective.com.au"),
    random: await resolves(`${randomBytes(8).toString("hex")}.example.com`),
    egress: await resolves("egress"),
  },
  // (a) allowed host, internal CA: green.
  discovery: await get({ connectTo: IDENTITY, sni: IDENTITY, host: IDENTITY, path: "/.well-known/oauth-authorization-server" }),
  // Without front's CA the same request must fail: front, not the real host, ended the TLS.
  discoveryPublicCaOnly: await get({ connectTo: IDENTITY, sni: IDENTITY, host: IDENTITY, path: "/.well-known/oauth-authorization-server", trust: "public" }),
  synapseNoKey: await get({ connectTo: SYNAPSE, sni: SYNAPSE, host: SYNAPSE, path: "/v1/models" }),
  // (b) SNI swap on identity's address (shared Cloudflare anycast upstream): red.
  sniSwap: await get({ connectTo: IDENTITY, sni: "www.cloudflare.com", host: "www.cloudflare.com", path: "/cdn-cgi/trace", trust: "none" }),
  sniSwapVault: await get({ connectTo: SYNAPSE, sni: "vault-mcp.alterspective.com.au", host: "vault-mcp.alterspective.com.au", path: "/health", trust: "none" }),
  // (c) Host swap on synapse2-api (shared Azure Container Apps front door): 421, never vault-mcp.
  hostSwap: await get({ connectTo: SYNAPSE, sni: SYNAPSE, host: "vault-mcp.alterspective.com.au", path: "/health" }),
  hostSwapAllowed: await get({ connectTo: SYNAPSE, sni: SYNAPSE, host: IDENTITY, path: "/.well-known/oauth-authorization-server" }),
  hostSwapAbsoluteUri: await rawTls({
    connectTo: SYNAPSE,
    sni: SYNAPSE,
    payload: `GET https://vault-mcp.alterspective.com.au/health HTTP/1.1\r\nHost: ${SYNAPSE}\r\nConnection: close\r\n\r\n`,
  }),
  // (d) any other host, a raw IP, or no SNI: red.
  // tls.connect to an IP sends no SNI (https.request would copy the Host header into SNI).
  noSni: await rawTls({ connectTo: frontIp, sni: undefined, verify: false, payload: `GET / HTTP/1.1\r\nHost: ${IDENTITY}\r\nConnection: close\r\n\r\n` }),
  directPublicIp: await rawTcp("1.1.1.1", 443),
  // (e) nothing speaks CONNECT: not front over TLS, not front in plain TCP, not the old ports.
  connectOverTls: await rawTls({ connectTo: IDENTITY, sni: IDENTITY, payload: `CONNECT www.cloudflare.com:443 HTTP/1.1\r\nHost: www.cloudflare.com:443\r\n\r\n` }),
  connectPlain: await rawTcp(frontIp, 443, `CONNECT www.cloudflare.com:443 HTTP/1.1\r\nHost: www.cloudflare.com:443\r\n\r\n`),
  oldProxyPorts: {
    8888: await rawTcp(frontIp, 8888),
    3128: await rawTcp(frontIp, 3128),
    8080: await rawTcp(frontIp, 8080),
    80: await rawTcp(frontIp, 80),
  },
  // (f) the Docker host side of `sealed`: nothing listens for the box there.
  gateway: { ip: GATEWAY, ports: await gatewayPorts() },
  // (h) R4-01: on Keystone, only the chosen connections' paths (and the OAuth paths) pass front.
  keystonePaths: await keystonePaths(),
  // (j) WS2 #48, review M2: Synapse from inside the sealed network. The live front's include is the
  // empty one (no owner token), so a model route reaches Synapse with no credential: 401 from Synapse.
  synapse: {
    usageMe: await rawRequest(SYNAPSE, "GET", "/v1/usage/me"),
    modelsNoToken: await rawRequest(SYNAPSE, "GET", "/v1/models"),
    chatNoToken: await rawRequest(SYNAPSE, "POST", "/v1/chat/completions"),
    // A box-supplied Authorization and x-api-key are dropped by front: same 401 as with none.
    chatBoxHeaders: await rawRequest(SYNAPSE, "POST", "/v1/chat/completions", [`Authorization: ${BOX_BEARER}`, "x-api-key: box-supplied-key"]),
  },
  // (g) IPv6: no address, no route, and no AAAA answer that could go round front.
  ipv6: {
    addresses: globalV6(),
    direct: await rawTcp(PUBLIC_V6, 443),
    names: { identity: await v6(IDENTITY), synapse: await v6(SYNAPSE), cloudflare: await v6("www.cloudflare.com") },
  },
}
process.stdout.write(JSON.stringify(result) + "\n")
