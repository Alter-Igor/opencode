// Runs INSIDE a sealed probe container (review R5-08): the round 5 raw-socket probes against front's
// Keystone server, sent byte for byte over TLS with NO credentials. Prints one JSON object:
// probe name → { statuses: [HTTP status of each response], front: whether the first answer is
// front's own error page (a refusal that never reached Keystone) }. The test judges the results.
// The live front is generated for an explicit set (test/egress-live.test.ts LIVE_SET) that has github,
// so /mcp/c/github is an allowed path.
import { readFileSync } from "node:fs"
import tls from "node:tls"

const CA = readFileSync("/etc/ocd-front-ca/ca.pem")
const ID = "identity.alterspective.com.au"
const T = 20_000
const ok = `/mcp/c/github`

/** A request head: method, target, Host (or none), extra header lines; always Connection: close. */
const head = (method, target, { host = ID, version = "HTTP/1.1", extra = [], close = true } = {}) =>
  [`${method} ${target} ${version}`, ...(host === null ? [] : [`Host: ${host}`]), "Accept: application/json, text/event-stream", ...extra, ...(close ? ["Connection: close"] : []), "", ""].join("\r\n")
const post = (target, options) => head("POST", target, { ...options, extra: [...(options?.extra ?? []), "Content-Length: 0"] })

/** [name, raw bytes]. Grouped as in adversarial-review.md § Round 5 "Probes". */
const PROBES = [
  // Paths: dot segments, %2F, //, ;, case, query strings, #, NUL, overlong UTF-8.
  ["dotsOut", post(`${ok}/../../dynamic`)],
  ["dotsOutEncoded", post(`${ok}/%2e%2e/%2e%2e/dynamic`)],
  ["encSlashOut", post(`${ok}%2F..%2F..%2Fdynamic`)],
  ["encSlashIn", post("/mcp/c%2Fgithub")],
  ["dotsIn", post("/mcp/c/x/../github")],
  ["dotIn", post("/mcp/c/./github")],
  ["doubleSlashIn", post("//mcp/c/github")],
  ["doubleSlashDynamic", post("//mcp//dynamic")],
  ["semicolon", post(`${ok};x=1`)],
  ["semicolonOut", post(`${ok};/../../dynamic`)],
  ["upperCase", post("/mcp/c/GitHub")],
  ["upperPrefix", post("/MCP/C/github")],
  ["trailingSlash", post(`${ok}/`)],
  ["query", post(`${ok}?x=1`)],
  ["emptyQuery", post(`${ok}?`)],
  ["encodedQuery", post(`${ok}%3Fx=1`)],
  ["rawHash", post(`${ok}#x`)],
  ["encodedHash", post(`${ok}%23x`)],
  ["encodedSpace", post(`${ok}%20`)],
  ["encodedAllowed", post("/mcp/c/%67ithub")],
  ["nul", post(`${ok}%00`)],
  ["overlongSlash", post(`${ok}%C0%AF..%C0%AF..%C0%AFdynamic`)],
  ["dynamic", post("/mcp/dynamic")],
  ["vaultConnection", post("/mcp/c/vault-global")],
  ["adminConnection", post("/mcp/c/keystone-admin")],
  ["adminApi", post("/api/mcp")],
  ["revoke", post("/api/oauth/revoke")],
  ["deviceAuthorization", post("/api/oauth/device/authorization")],
  ["userinfo", head("GET", "/api/oidc/userinfo")],
  ["tokenGet", head("GET", "/api/oidc/token")],
  // Methods on an allowed path.
  ["head", head("HEAD", ok)],
  ["options", head("OPTIONS", ok)],
  ["put", post(ok).replace(/^POST/, "PUT")],
  ["patch", post(ok).replace(/^POST/, "PATCH")],
  ["trace", head("TRACE", ok)],
  ["connect", head("CONNECT", `${ID}:443`, { host: `${ID}:443` })],
  // Absolute form and Host tricks.
  ["absoluteAllowed", post(`https://${ID}${ok}`)],
  ["absoluteDynamic", post(`https://${ID}/mcp/dynamic`)],
  ["absoluteOtherHost", post(`https://evil.example${ok}`)],
  ["http10NoHost", head("GET", ok, { host: null, version: "HTTP/1.0" })],
  ["hostWithPort", post("/mcp/dynamic", { host: `${ID}:443` })],
  ["hostOther", post(ok, { host: "evil.example" })],
  // Smuggling and pipelining.
  ["teAndCl", head("POST", ok, { extra: ["Content-Length: 4", "Transfer-Encoding: chunked"] }) + "0\r\n\r\n"],
  ["teObfuscated", head("POST", ok, { extra: ["Transfer-Encoding: xchunked"] })],
  ["pipelined", post(ok, { close: false }) + post("/mcp/dynamic")],
]

function send(payload) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: ID, port: 443, servername: ID, ca: CA, timeout: T, ALPNProtocols: ["http/1.1"] })
    let buffer = ""
    const parse = () => ({
      statuses: [...buffer.matchAll(/(?:^|\r\n)HTTP\/1\.[01] (\d{3}) /g)].map((m) => Number(m[1])),
      front: buffer.slice(0, 4000).includes("<center>nginx</center>"),
    })
    const done = (value) => (socket.destroy(), resolve(value))
    socket.on("secureConnect", () => socket.write(payload, "latin1"))
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1")
      if (buffer.length > 16_000) done(parse())
    })
    socket.on("timeout", () => done(buffer ? parse() : { error: "timeout" }))
    socket.on("error", (error) => done(buffer ? parse() : { error: error.code ?? "error" }))
    socket.on("end", () => done(buffer ? parse() : { error: "closed" }))
  })
}

const out = {}
for (const [name, payload] of PROBES) out[name] = await send(payload)
process.stdout.write(JSON.stringify(out) + "\n")
