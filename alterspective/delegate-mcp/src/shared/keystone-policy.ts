// The owner's limits on the Keystone set (review R5-03, R5-04, R5-02/R5-06).
//
// Ceiling (R5-03): oc_server_restart {keystone} takes its ids from a tool call, and `confirm` is a
// value the calling model supplies, so a tool call alone must never widen what the box can reach.
// The owner sets the ceiling OUTSIDE tool calls, in the bridge's launch env
// (OPENCODE_DELEGATE_KEYSTONE_ALLOWED, read once at bridge start). Without it the ceiling is the
// default set. Every set the box runs with (requested, saved or default) must sit inside it.
//
// High-risk ids (R5-04): one Keystone connection can relay to many services (agents that read mail,
// admin tools, vault secrets). Ids that start with one of these prefixes are flagged by oc_doctor
// whenever they are in the ceiling or the set. Prefix match on purpose: a false alarm costs a look,
// a miss costs the mailbox.
//
// Tool deny list (R5-02, R5-06): write tools of the default services, denied in the box profile and
// in every session's rules. CONVENIENCE, NOT A WALL: in-box code can call the connection with the
// box's own tokens and skip OpenCode's permissions entirely (README "Security").
import { DelegateError } from "./errors.ts"
import { CONNECTION_ID } from "./keystone.ts"

export const CEILING_ENV = "OPENCODE_DELEGATE_KEYSTONE_ALLOWED"
export const TOOL_DENY_ENV = "OPENCODE_DELEGATE_KEYSTONE_TOOL_DENY"
/** Bounded like the set itself, with room for the owner's wider choices. */
export const MAX_CEILING = 100

export const HIGH_RISK_PREFIXES = ["cas", "vault", "keystone-admin", "m365", "monday", "hubspot", "stripe", "xero", "sharedo"] as const

/**
 * OpenCode MCP tool ids are `<entry>_<tool>` (packages/opencode/src/mcp/catalog.ts toolName).
 * rag-global (only if the owner chooses it over the default rag-read): ingest of a URL fetches any
 * public page server-side; ingest and contribute write to the shared knowledge base (or open a PR in
 * the knowledge repo); delete_collection is irreversible. rag-read needs no entries here: its
 * Keystone service policy is an allowlist of read tools (the wall, issue #56).
 * seqlogs: aliases are a lasting shared mapping other agents use; monitors are background jobs.
 */
export const DEFAULT_TOOL_DENY = [
  "ks-rag-global_rag_ingest",
  "ks-rag-global_rag_ingest_document",
  "ks-rag-global_rag_delete_collection",
  "ks-rag-global_rag_contribute",
  "ks-seqlogs_set_tenant_alias",
  "ks-seqlogs_start_tenant_monitor",
  "ks-seqlogs_stop_tenant_monitor",
] as const

/** `ks-<connection id>_<tool>`; `*` allowed in the tool part (OpenCode wildcard). */
const TOOL_DENY_NAME = /^ks-[a-z0-9][a-z0-9-]{0,62}_[A-Za-z0-9_*-]{1,128}$/

export type CeilingConfig = { keystoneConnections: readonly string[]; keystoneAllowed?: readonly string[] }

/** A comma list from the env, trimmed; undefined when the variable is unset. */
export function envList(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(",").map((item) => item.trim()).filter(Boolean)
}

/** The owner's ceiling: keystoneAllowed (launch env) or, without it, the default set. Fails closed on a bad id. */
export function ceilingOf(config: CeilingConfig): string[] {
  const list = [...(config.keystoneAllowed ?? config.keystoneConnections)]
  const bad = list.find((id) => !CONNECTION_ID.test(id))
  if (bad !== undefined || list.length > MAX_CEILING)
    throw new DelegateError(
      "profile_invalid",
      `The owner's Keystone ceiling (${CEILING_ENV}) is not valid, so no Keystone set is accepted.`,
      `Fix ${CEILING_ENV} in this MCP server's config (comma list of connection ids, at most ${MAX_CEILING}), then restart the MCP client.`,
      bad !== undefined ? `bad id ${bad.slice(0, 40)}` : `${list.length} ids`,
    )
  return [...new Set(list)]
}

/** Throws policy_violation naming the ids outside the ceiling. A tool call can never raise the ceiling. */
export function enforceCeiling(ids: readonly string[], config: CeilingConfig): void {
  const ceiling = new Set(ceilingOf(config))
  const outside = ids.filter((id) => !ceiling.has(id))
  if (outside.length === 0) return
  const list = outside.join(", ").slice(0, 200)
  throw new DelegateError(
    "policy_violation",
    `Keystone connection${outside.length === 1 ? "" : "s"} ${list} ${outside.length === 1 ? "is" : "are"} outside the owner's allowed list, so nothing was changed.`,
    `Only the owner can allow ${outside.length === 1 ? "it" : "them"}: add the id${outside.length === 1 ? "" : "s"} to ${CEILING_ENV} (comma list) in this MCP server's env in the client config, then restart the MCP client. Check what each connection can reach first (README "Keystone services").`,
    `outside ceiling: ${list}`,
  )
}

/** Ids that match a high-risk prefix. */
export const highRiskIds = (ids: readonly string[]) => ids.filter((id) => HIGH_RISK_PREFIXES.some((prefix) => id.startsWith(prefix)))

/** Validated tool deny names. A bad name fails closed: a typo must not quietly drop a deny. */
export function toolDenyNames(names: readonly string[]): string[] {
  const bad = names.find((name) => !TOOL_DENY_NAME.test(name))
  if (bad !== undefined)
    throw new DelegateError(
      "profile_invalid",
      `The Keystone tool deny list (${TOOL_DENY_ENV}) has an invalid name, so the sandbox profile was not built.`,
      `Use ks-<connection id>_<tool> names, comma separated, in ${TOOL_DENY_ENV}, then restart the MCP client.`,
      `bad name ${bad.slice(0, 80)}`,
    )
  return [...new Set(names)]
}
