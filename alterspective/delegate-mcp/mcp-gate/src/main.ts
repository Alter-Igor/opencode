// #104: the delegation gate for Keystone /mcp/dynamic (see server.ts).
// Env (set by compose from the bridge's `docker compose` child process; values never in a file):
//   GATE_HOST          the address the front listener binds (its `gatenet` alias; default 127.0.0.1)
//   GATE_PORT          front listener port (default 8090)
//   GATE_ADMIN_HOST    the address the admin listener binds (its `admin` network alias)
//   GATE_ADMIN_PORT    admin listener port (default 8091)
//   GATE_ADMIN_TOKEN   per-start admin token (required)
//   GATE_UPSTREAM      fixed upstream, https only (default https://identity.alterspective.com.au/mcp/dynamic)
//   GATE_PROFILE       the delegation profile, JSON (policy.ts); empty = the default profile
import { ApprovalStore } from "./approvals.ts"
import { parseProfile } from "./policy.ts"
import { adminHandler, frontHandler, type GateConfig } from "./server.ts"

const env = process.env
const adminToken = env.GATE_ADMIN_TOKEN ?? ""
if (adminToken.length < 32) {
  process.stderr.write("mcp-gate: GATE_ADMIN_TOKEN is missing or too short; refusing to start\n")
  process.exit(1)
}
const upstream = env.GATE_UPSTREAM || "https://identity.alterspective.com.au/mcp/dynamic"
if (new URL(upstream).protocol !== "https:") {
  process.stderr.write("mcp-gate: GATE_UPSTREAM must be https; refusing to start\n")
  process.exit(1)
}
let profile
try {
  profile = parseProfile(env.GATE_PROFILE)
} catch (error) {
  // Fail closed: a damaged profile must never fall back to "everything".
  process.stderr.write(`mcp-gate: ${(error as Error).message}; refusing to start\n`)
  process.exit(1)
}

const log = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), service: "mcp-gate", ...event })}\n`)
const config: GateConfig = { upstream, profile, adminToken, approvals: new ApprovalStore(), log }
const front = frontHandler(config)
const admin = adminHandler(config)
const failed = (error: unknown) => {
  log({ event: "error", reason: error instanceof Error ? error.message.slice(0, 200) : "error" })
  return new Response(JSON.stringify({ error: "the delegation gate could not reach Keystone" }), { status: 502, headers: { "content-type": "application/json" } })
}

Bun.serve({ hostname: env.GATE_HOST || "127.0.0.1", port: Number(env.GATE_PORT || 8090), fetch: front, error: failed })
Bun.serve({ hostname: env.GATE_ADMIN_HOST || "127.0.0.1", port: Number(env.GATE_ADMIN_PORT || 8091), fetch: admin, error: failed })
log({ event: "started", upstream, profile: Object.keys(profile).length === 0 ? "default" : "custom" })
