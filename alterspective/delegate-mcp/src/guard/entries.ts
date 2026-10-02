// MOD-02 profile-time MCP allowlist (technical-design §3.2). Fails closed.
// At least as strict as the fork patch (packages/opencode/src/mcp/allowlist.ts), and in
// addition: names must be ks-<id>, each entry must point at its own /mcp/c/<id>, the id must be
// in the chosen Keystone set (R4-01: never /mcp/dynamic), the key set is closed, `headers` may not
// appear at all, oauth values must be strings, and enabled:false entries are still validated.
// #67 step 4: with host-held Keystone tokens (OCD_KEYSTONE_HOST_AUTH=1) front adds each
// connection's credential, so the box must NOT run its own OAuth: every entry must carry exactly
// `oauth: false` (the fork accepts it since step 2). With the flag off, `oauth: false` stays refused.
import type { McpEntry, Verdict } from "../shared/contracts.ts"
import { idOfEntry } from "../shared/keystone.ts"
import { keystoneHostAuth } from "./egress-identity.ts"

/** Entry names the bridge accepts, both in the profile and in GET /mcp: `ks-` + a connection id. */
export const KS_NAME = /^ks-[a-z0-9][a-z0-9-]{0,62}$/
const ENTRY_KEYS = new Set(["type", "url", "oauth", "enabled", "timeout"])
const OAUTH_KEYS = new Set(["scope", "clientId"])

type Check = string | undefined

const violation = (name: string, why: string): Verdict => ({
  ok: false,
  code: "policy_violation",
  reason: `MCP entry "${name}": ${why}`,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function checkKeys(entry: Record<string, unknown>): Check {
  if ("headers" in entry) return "static headers are not allowed (a shared key bypasses per-user OAuth)"
  const extra = Object.keys(entry).filter((key) => !ENTRY_KEYS.has(key))
  if (extra.length > 0) return `unexpected field(s) ${extra.join(", ")}`
  if (entry.type !== "remote") return "type must be \"remote\""
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") return "enabled must be a boolean"
  if (entry.timeout !== undefined && typeof entry.timeout !== "number") return "timeout must be a number"
  return undefined
}

function checkOAuth(oauth: unknown): Check {
  if (oauth === undefined) return undefined
  if (!isRecord(oauth)) return "oauth must be absent or an object with scope/clientId only"
  const extra = Object.keys(oauth).filter((key) => !OAUTH_KEYS.has(key))
  if (extra.length > 0) return `oauth.${extra.join(", oauth.")} is not allowed`
  const bad = Object.entries(oauth).filter(([, value]) => typeof value !== "string")
  if (bad.length > 0) return `oauth.${bad.map(([key]) => key).join(", oauth.")} must be a string`
  return undefined
}

function checkUrl(raw: unknown, origin: string, id: string): Check {
  if (typeof raw !== "string" || !URL.canParse(raw)) return "url is missing or does not parse"
  const url = new URL(raw)
  if (url.username || url.password) return "url must not contain credentials"
  if (url.search || url.hash || /[?#]/.test(raw)) return "url must not contain a query or fragment"
  // Exact origin equality on the parsed URL — never a prefix (look-alike hosts), never http.
  if (url.protocol !== "https:" || url.origin !== origin) return `origin ${url.origin} is not ${origin}`
  // The parsed pathname is already normalised (".." and "%2e%2e" resolved) — that is what the
  // transport will request, so that is what is tested.
  // Exact equality: one entry, one connection. /mcp/dynamic and any other Keystone path are refused.
  if (url.pathname !== `/mcp/c/${id}`) return `path ${url.pathname} is not /mcp/c/${id}`
  return undefined
}

/** Host-held tokens: the box must not sign in itself, so `oauth` is exactly `false`, nothing else. */
const checkHostOAuth = (oauth: unknown): Check =>
  oauth === false ? undefined : "oauth must be exactly false while host-held Keystone tokens are on (OCD_KEYSTONE_HOST_AUTH=1)"

function checkEntry(name: string, entry: unknown, origin: string, allowed: ReadonlySet<string>, hostAuth: boolean): Check {
  const id = KS_NAME.test(name) ? idOfEntry(name) : undefined
  if (id === undefined) return "name must be ks-<connection id> (^ks-[a-z0-9][a-z0-9-]{0,62}$)"
  if (!allowed.has(id)) return `connection ${id} is not in the chosen Keystone set`
  if (!isRecord(entry)) return "entry must be an object"
  return checkKeys(entry) ?? (hostAuth ? checkHostOAuth(entry.oauth) : checkOAuth(entry.oauth)) ?? checkUrl(entry.url, origin, id)
}

/**
 * Validate every MCP entry of a profile. `keystoneOrigin` is config.keystoneOrigin; it must be
 * an https origin itself, otherwise every entry is refused. `connections` is the chosen Keystone
 * set (config.currentKeystone): an entry for any other connection is refused. `hostAuth`
 * (default: OCD_KEYSTONE_HOST_AUTH=1) requires `oauth: false` on every entry.
 */
export function validateEntries(entries: Record<string, McpEntry>, keystoneOrigin: string, connections: readonly string[], hostAuth: boolean = keystoneHostAuth()): Verdict {
  if (!URL.canParse(keystoneOrigin) || new URL(keystoneOrigin).origin !== keystoneOrigin || !keystoneOrigin.startsWith("https://")) {
    return { ok: false, code: "policy_violation", reason: `configured Keystone origin ${keystoneOrigin} is not an https origin` }
  }
  if (!isRecord(entries)) return { ok: false, code: "policy_violation", reason: "MCP entries must be an object" }
  const allowed = new Set(connections)
  for (const [name, entry] of Object.entries(entries)) {
    const problem = checkEntry(name, entry, keystoneOrigin, allowed, hostAuth)
    if (problem) return violation(name, problem)
  }
  return { ok: true }
}
