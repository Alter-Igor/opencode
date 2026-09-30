// Runs INSIDE the sealed client container (docker/egress/live/compose.yaml). Prints one JSON object.
// Every probe speaks raw HTTP to the proxy, so nothing depends on a client's proxy handling.
import dns from "node:dns/promises"
import net from "node:net"
import { randomBytes } from "node:crypto"

const PROXY = { host: "egress", port: 8888 }

/** Send one raw request to the proxy and return its status line (or the error). */
function statusLine(request) {
  return new Promise((resolve) => {
    const socket = net.connect(PROXY)
    let buffer = ""
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(20_000, () => done("timeout"))
    socket.on("error", (error) => done(`error: ${error.code ?? error.message}`))
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1")
      const end = buffer.indexOf("\r\n")
      if (end >= 0) done(buffer.slice(0, end))
    })
    socket.on("end", () => done(buffer || "closed"))
    socket.write(request)
  })
}

const connect = (target) => statusLine(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
const plain = (url, host) => statusLine(`GET ${url} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)

async function resolves(name) {
  try {
    const found = await dns.lookup(name, { all: true })
    return found.length > 0
  } catch {
    return false
  }
}

async function direct(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 5_000 })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.on("connect", () => done(true))
    socket.on("timeout", () => done(false))
    socket.on("error", () => done(false))
  })
}

const allowed = process.argv[2] ?? "identity.alterspective.com.au"
const random = `${randomBytes(8).toString("hex")}.example.com`

const result = {
  connectAllowed: await connect(`${allowed}:443`),
  connectDenied: await connect("example.com:443"),
  connectAllowedPort80: await connect(`${allowed}:80`),
  connectTrailingDot: await connect(`${allowed}.:443`),
  plainAllowed: await plain(`http://${allowed}/`, allowed),
  plainDenied: await plain("http://example.com/", "example.com"),
  plainAllowedPort443: await plain(`http://${allowed}:443/`, `${allowed}:443`),
  plainNoScheme: await plain(`${allowed}:443`, `${allowed}:443`),
  plainOriginForm: await plain("/", `${allowed}:443`),
  dnsRandom: await resolves(random),
  dnsExample: await resolves("example.com"),
  dnsAllowed: await resolves(allowed),
  dnsEgress: await resolves("egress"),
  directToPublicIp: await direct("1.1.1.1", 443),
}
process.stdout.write(JSON.stringify(result) + "\n")
