// Spike T0.2: does the fork's single-flight refresh stop concurrent instances racing one
// Keystone refresh-token family? (technical-design.md §3.4 item 3, evidence/wave0-spikes.md T0.2)
//
// PRECONDITIONS (the script checks them and stops if not met):
//   1. The delegate box is running: project `opencode-delegate`, container `opencode-delegate`.
//   2. A HUMAN has already signed ks-delegate in (GET /mcp shows ks-delegate: connected).
//      This script never starts a sign-in.
//
// RUN (from the host, owner's shell with Docker access):
//   node alterspective/delegate-mcp/spike/t02-race.mjs --yes
//
// WHAT IT DOES
//   a. Makes the stored ks-delegate access token look expired inside the box volume
//      (/data/opencode/mcp-auth.json): expiresAt → 60 s ago and accessToken → an invalid
//      placeholder, so Keystone answers 401 and the MCP SDK must refresh. The refresh token is
//      left untouched. Done inside the box by `node` as the agent user; no token is printed.
//   b. Fires tool listings from 3 new directories at the same moment. Each directory is a
//      separate OpenCode instance with its own MCP client, so without single-flight each would
//      present the same refresh token and Keystone's reuse detection would answer invalid_grant.
//   c. Prints per-directory status, whether the stored token was replaced, and whether
//      `invalid_grant` appears in any response or in the box's OpenCode logs since the start.
//
// RISK: if the fix does NOT work, Keystone may revoke the whole token family and the owner has
// to sign in again. That is why --yes is required. Prints no secrets (password stays in memory).
import { execFileSync } from "node:child_process"

const CONTAINER = "opencode-delegate"
const LABEL_PORT = "com.alterspective.opencode-delegate.port"
if (!process.argv.includes("--yes")) {
  console.log("Refusing to run without --yes (this can revoke the ks-delegate sign-in). Read the header first.")
  process.exit(2)
}

const docker = (args, input) => execFileSync("docker", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] })

function boxTarget() {
  const raw = JSON.parse(docker(["inspect", "--type", "container", "--format", '{"env":{{json .Config.Env}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}}}', CONTAINER]))
  if (!raw.running) throw new Error("the delegate box is not running")
  const line = raw.env.find((e) => e.startsWith("OPENCODE_SERVER_PASSWORD="))
  const password = line ? line.slice("OPENCODE_SERVER_PASSWORD=".length) : ""
  if (!password) throw new Error("box has no server password")
  return { base: `http://127.0.0.1:${raw.labels[LABEL_PORT]}`, auth: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") }
}

const { base, auth } = boxTarget()
const call = async (path, directory) => {
  const url = `${base}${path}?directory=${encodeURIComponent(directory)}`
  const started = Date.now()
  try {
    const res = await fetch(url, { headers: { authorization: auth }, signal: AbortSignal.timeout(90_000) })
    return { status: res.status, text: await res.text(), ms: Date.now() - started }
  } catch (error) {
    return { status: 0, text: String(error), ms: Date.now() - started }
  }
}

// Runs inside the box as the agent user. Reads/writes only the ks-delegate entry; prints booleans.
const TAMPER = `
const fs = require("fs"); const f = "/data/opencode/mcp-auth.json";
const data = JSON.parse(fs.readFileSync(f, "utf8")); const e = data["ks-delegate"];
if (!e || !e.tokens || !e.tokens.refreshToken) { console.log(JSON.stringify({ ok: false, why: "no ks-delegate tokens with a refresh token" })); process.exit(0) }
const crypto = require("crypto");
const fingerprint = (t) => crypto.createHash("sha256").update(String(t)).digest("hex").slice(0, 12);
const before = { access: fingerprint(e.tokens.accessToken), refresh: fingerprint(e.tokens.refreshToken) };
e.tokens.accessToken = "t02-expired-" + crypto.randomBytes(8).toString("hex");
e.tokens.expiresAt = Date.now() / 1000 - 60;
fs.writeFileSync(f, JSON.stringify(data, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ok: true, before }));`

const FINGERPRINT = `
const fs = require("fs"); const crypto = require("crypto");
const e = JSON.parse(fs.readFileSync("/data/opencode/mcp-auth.json", "utf8"))["ks-delegate"] || {};
const fp = (t) => t ? crypto.createHash("sha256").update(String(t)).digest("hex").slice(0, 12) : null;
const t = e.tokens || {};
console.log(JSON.stringify({ access: fp(t.accessToken), refresh: fp(t.refreshToken), placeholder: String(t.accessToken || "").startsWith("t02-expired-"), expiresInSec: t.expiresAt ? Math.round(t.expiresAt - Date.now() / 1000) : null }));`

const pre = await call("/mcp", "/sessions")
const preStatus = JSON.parse(pre.text || "{}")["ks-delegate"]?.status
console.log("precheck GET /mcp ks-delegate:", preStatus)
if (preStatus !== "connected") {
  console.log("Stop: ks-delegate is not connected. A human must sign in first (oc_login or spike/t01/t03-login.mjs).")
  process.exit(3)
}

const countLogHits = () =>
  Number(docker(["exec", "-u", "agent", CONTAINER, "sh", "-c", "cat /data/opencode/log/*.log 2>/dev/null | grep -ci invalid_grant || true"]).trim() || 0)
const hitsBefore = countLogHits()
const stamp = Date.now()
const dirs = [1, 2, 3].map((n) => `/sessions/t02-race-${stamp}-${n}`)
docker(["exec", "-u", "agent", CONTAINER, "mkdir", "-p", ...dirs])
const tamper = JSON.parse(docker(["exec", "-i", "-u", "agent", CONTAINER, "node", "-"], TAMPER).trim())
console.log("tamper:", JSON.stringify(tamper))
if (!tamper.ok) process.exit(4)

// Same instant, three fresh instances: each connects ks-delegate, gets 401, and must refresh.
const results = await Promise.all(dirs.map((dir) => call("/experimental/tool/ids", dir)))
const statuses = await Promise.all(dirs.map((dir) => call("/mcp", dir)))
let invalidGrant = false
dirs.forEach((dir, i) => {
  const ids = (() => { try { return JSON.parse(results[i].text) } catch { return [] } })()
  const ks = Array.isArray(ids) ? ids.filter((id) => String(id).startsWith("ks-delegate_")).length : 0
  const mcp = JSON.parse(statuses[i].text || "{}")["ks-delegate"] ?? {}
  if (/invalid_grant/i.test(results[i].text + statuses[i].text)) invalidGrant = true
  console.log(`dir ${i + 1}: tool/ids HTTP ${results[i].status} in ${results[i].ms} ms, ks-delegate tools=${ks}; GET /mcp ks-delegate=${mcp.status}${mcp.error ? " error=" + String(mcp.error).slice(0, 160) : ""}`)
})

const after = JSON.parse(docker(["exec", "-i", "-u", "agent", CONTAINER, "node", "-"], FINGERPRINT).trim())
console.log("stored token after:", JSON.stringify({ ...after, refreshRotated: after.refresh !== tamper.before.refresh }))
const logHits = countLogHits() - hitsBefore
if (logHits > 0) invalidGrant = true
console.log(`new log lines with invalid_grant during the race: ${logHits}`)
console.log(invalidGrant ? "RESULT: Keystone returned invalid_grant — the race is NOT fixed (T0.2 FAIL)." : "RESULT: no invalid_grant — single-flight refresh held (T0.2 PASS if all three show connected).")
