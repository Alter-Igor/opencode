// MOD-02 profile-time MCP allowlist (technical-design §3.2). Fails closed.
// At least as strict as the fork patch (packages/opencode/src/mcp/allowlist.ts), and in
// addition: names must be ks-*, the key set is closed, `headers` may not appear at all,
// oauth values must be strings, and enabled:false entries are still validated.
import type { McpEntry, Verdict } from "../shared/contracts.ts"

/** Entry names the bridge accepts, both in the profile and in GET /mcp. */
export const KS_NAME = /^ks-[a-z0-9-]+$/
/** Same pattern as mcpAllowPolicy (shared/config.ts); a test keeps them equal. */
export const KS_PATH = "^/mcp/(dynamic|c/[A-Za-z0-9_-]+)$"

const PATH = new RegExp(KS_PATH)
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

function checkUrl(raw: unknown, origin: string): Check {
  if (typeof raw !== "string" || !URL.canParse(raw)) return "url is missing or does not parse"
  const url = new URL(raw)
  if (url.username || url.password) return "url must not contain credentials"
  if (url.search || url.hash || /[?#]/.test(raw)) return "url must not contain a query or fragment"
  // Exact origin equality on the parsed URL — never a prefix (look-alike hosts), never http.
  if (url.protocol !== "https:" || url.origin !== origin) return `origin ${url.origin} is not ${origin}`
  // The parsed pathname is already normalised (".." and "%2e%2e" resolved) — that is what the
  // transport will request, so that is what is tested.
  if (!PATH.test(url.pathname)) return `path ${url.pathname} is not /mcp/dynamic or /mcp/c/<connectionId>`
  return undefined
}

function checkEntry(name: string, entry: unknown, origin: string): Check {
  if (!KS_NAME.test(name)) return "name must match ^ks-[a-z0-9-]+$"
  if (!isRecord(entry)) return "entry must be an object"
  return checkKeys(entry) ?? checkOAuth(entry.oauth) ?? checkUrl(entry.url, origin)
}

/**
 * Validate every MCP entry of a profile. `keystoneOrigin` is config.keystoneOrigin; it must be
 * an https origin itself, otherwise every entry is refused.
 */
export function validateEntries(entries: Record<string, McpEntry>, keystoneOrigin: string): Verdict {
  if (!URL.canParse(keystoneOrigin) || new URL(keystoneOrigin).origin !== keystoneOrigin || !keystoneOrigin.startsWith("https://")) {
    return { ok: false, code: "policy_violation", reason: `configured Keystone origin ${keystoneOrigin} is not an https origin` }
  }
  if (!isRecord(entries)) return { ok: false, code: "policy_violation", reason: "MCP entries must be an object" }
  for (const [name, entry] of Object.entries(entries)) {
    const problem = checkEntry(name, entry, keystoneOrigin)
    if (problem) return violation(name, problem)
  }
  return { ok: true }
}
