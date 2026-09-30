// Spike T0.3: Keystone sign-in for the boxed OpenCode, relayed through the host.
// Starts the MCP OAuth flow in the box, opens the owner's browser, catches the loopback
// redirect on the host, checks state, and hands the code to the box. Prints no secrets.
import http from "node:http"
import { spawn } from "node:child_process"

const base = process.env.OCD_URL ?? "http://127.0.0.1:47096"
const dir = encodeURIComponent("/work/demo")
const auth = "Basic " + Buffer.from("opencode:" + process.env.OCD_PASSWORD).toString("base64")
const call = (path, body) =>
  fetch(`${base}${path}?directory=${dir}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: auth, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))

const start = await call("/mcp/ks-delegate/auth", {})
if (start.status !== 200) throw new Error(`auth start failed: ${start.status}`)
const { authorizationUrl, oauthState } = start.json

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:19876")
  if (url.pathname !== "/mcp/oauth/callback") return res.writeHead(404).end()
  const code = url.searchParams.get("code")
  if (!code || url.searchParams.get("state") !== oauthState) {
    res.writeHead(400).end("State mismatch or missing code. Nothing was sent.")
    return console.log("callback refused: state mismatch or missing code")
  }
  const done = await call("/mcp/ks-delegate/auth/callback", { code })
  res.writeHead(200, { "content-type": "text/plain" }).end(`Sign-in relayed to the delegate box (HTTP ${done.status}). You can close this tab.`)
  console.log("callback relayed, box answered", done.status)
  const status = await call("/mcp", null)
  console.log("GET /mcp ->", JSON.stringify(status.json))
  server.close()
})
server.listen(19876, "127.0.0.1", () => {
  console.log("listening on 127.0.0.1:19876; opening browser")
  spawn("rundll32", ["url.dll,FileProtocolHandler", authorizationUrl], { detached: true, stdio: "ignore" }).unref()
})
setTimeout(() => {
  console.log("timed out after 5 minutes")
  process.exit(2)
}, 300_000).unref()
