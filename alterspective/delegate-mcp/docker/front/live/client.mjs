// Runs INSIDE the sealed probe container (docker/front/live/probe.yaml). Prints one JSON object.
// Every request is a public, read-only GET. No credentials are ever sent.
import dns from "node:dns/promises"
import { readFileSync } from "node:fs"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import { randomBytes } from "node:crypto"

const CA = readFileSync("/etc/ocd-front-ca/ca.pem")
const IDENTITY = "identity.alterspective.com.au"
const SYNAPSE = "synapse2-api.alterspective.com.au"
const T = 20_000

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
        res.on("end", () => resolve({ status: res.statusCode, body: body.slice(0, 400) }))
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
}
process.stdout.write(JSON.stringify(result) + "\n")
