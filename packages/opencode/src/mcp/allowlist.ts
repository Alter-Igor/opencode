// Alterspective fork (FEAT-OCD-001 §3.4): env-gated MCP allowlist.
// When OPENCODE_MCP_ALLOW is set, only remote MCP entries whose URL matches an allowed
// origin + path pattern may connect. A malformed policy refuses every entry (fail closed).
// Unset or empty keeps upstream behaviour.
import { Option, Schema } from "effect"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"

export const ENV = "OPENCODE_MCP_ALLOW"

const Policy = Schema.Struct({
  remote: Schema.Array(Schema.Struct({ origin: Schema.String, path: Schema.String })),
})
const decodePolicy = Schema.decodeUnknownOption(Schema.fromJsonString(Policy))

// Keys that would let a config bring its own client secret or move the OAuth callback.
const ALLOWED_OAUTH_KEYS = new Set(["scope", "clientId"])

export type Result = { ok: true } | { ok: false; reason: string }

type Rule = { origin: string; path: RegExp }

const ok: Result = { ok: true }
const refuse = (reason: string): Result => ({ ok: false, reason })

function loadRules(raw: string): Rule[] | string {
  const policy = decodePolicy(raw)
  if (Option.isNone(policy)) return `${ENV} is not valid JSON of shape {"remote":[{"origin","path"}]}`
  const rules: Rule[] = []
  for (const entry of policy.value.remote) {
    try {
      rules.push({ origin: entry.origin, path: new RegExp(entry.path) })
    } catch {
      return `${ENV} has an invalid path pattern: ${entry.path}`
    }
  }
  return rules
}

function checkOAuth(oauth: ConfigMCPV1.Remote["oauth"]): Result {
  // #67: oauth:false is allowed. OpenCode then builds no OAuth client, does no discovery and refuses
  // an in-box sign-in; the Authorization header is added outside the box. URL rules still apply.
  if (oauth === undefined || oauth === false) return ok
  const extra = Object.keys(oauth).filter((key) => !ALLOWED_OAUTH_KEYS.has(key))
  if (extra.length > 0) return refuse(`oauth.${extra.join(", oauth.")} is not allowed`)
  return ok
}

function checkUrl(raw: string, rules: Rule[]): Result {
  if (!URL.canParse(raw)) return refuse("URL does not parse")
  const url = new URL(raw)
  if (url.username || url.password) return refuse("URL must not contain credentials")
  if (url.search || url.hash || /[?#]/.test(raw)) return refuse("URL must not contain a query or fragment")
  // Compare the parsed origin exactly (never a prefix), then test the normalised pathname
  // that the transport will actually request.
  const allowed = rules.some((rule) => url.origin === rule.origin && rule.path.test(url.pathname))
  if (!allowed) return refuse(`${url.origin}${url.pathname} is not an allowed MCP URL`)
  return ok
}

export function check(name: string, config: ConfigMCPV1.Info, env: string | undefined = process.env[ENV]): Result {
  if (!env?.trim()) return ok
  const rules = loadRules(env)
  if (typeof rules === "string") return refuse(rules)
  if (config.type !== "remote") return refuse(`"${name}" is not a remote MCP server`)
  if (config.headers && Object.keys(config.headers).length > 0) return refuse("static headers are not allowed")
  const oauth = checkOAuth(config.oauth)
  if (!oauth.ok) return oauth
  return checkUrl(config.url, rules)
}

export function blockedMessage(reason: string) {
  return `blocked by ${ENV}: ${reason}`
}

export * as McpAllow from "./allowlist"
