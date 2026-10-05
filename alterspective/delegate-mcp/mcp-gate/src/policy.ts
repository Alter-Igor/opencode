// #104: the delegation profile the gate enforces on Keystone /mcp/dynamic tool calls.
//
// The field names and their meaning are CAS's (alterspective-agent src/core/domain/agent.ts
// allowedToolPatterns / approvalRequiredToolPatterns), so a profile reads the same in both places.
// The pattern matcher and the risk words are COPIED from CAS (src/core/domain/tool-pattern-match.ts,
// src/core/domain/tool-risk.ts, src/core/config/coding-delegate-reach.ts), not shared: the two
// products ship separately (fork alterspective/sandbox-worker/README.md). Keep them in step by hand.
//
// Default (no profile): every tool the owner's Keystone account can reach, and any tool that may
// change something, send data out or run code waits for an approval (owner decision 2026-10-04,
// option A). A profile can only narrow that: deny tools, or allow fewer.

/** A tool name pattern: letters, digits, `_`, `-`, `.` and `*` (CAS's charset plus `.`). */
const VALID_PATTERN = /^[a-zA-Z0-9_.*-]{1,200}$/

export type Profile = {
  /** Tools the delegated task may use. Missing or empty means every tool. */
  allowedToolPatterns?: string[]
  /** Tools the task may never use, even when allowed above. */
  deniedToolPatterns?: string[]
  /** Tools that always wait for an approval. */
  approvalRequiredToolPatterns?: string[]
  /** "risky" (default): tools that may change, send out or run code also wait. "listed": only the patterns above. */
  approvals?: "risky" | "listed"
}

export type Decision = { effect: "allow" } | { effect: "deny"; reason: string } | { effect: "approve"; reason: string }

/** CAS matchToolPattern: exact, or `*` as "any run of characters". */
export function matchToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return toolName === pattern
  const escaped = pattern.replace(/[.]/g, "\\.").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(toolName)
}

export const matchesAnyPattern = (toolName: string, patterns: readonly string[]) => patterns.some((p) => matchToolPattern(toolName, p))

/** Throws on a profile that is not well formed, so a typo never widens what a task can reach. */
export function parseProfile(raw: string | undefined): Profile {
  if (raw === undefined || raw.trim() === "") return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("delegation profile is not JSON")
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("delegation profile must be a JSON object")
  const input = value as Record<string, unknown>
  const known = new Set(["allowedToolPatterns", "deniedToolPatterns", "approvalRequiredToolPatterns", "approvals"])
  const unknown = Object.keys(input).find((key) => !known.has(key))
  if (unknown !== undefined) throw new Error(`delegation profile has an unknown field: ${unknown.slice(0, 40)}`)
  const list = (key: string): string[] | undefined => {
    const v = input[key]
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.length > 200 || v.some((p) => typeof p !== "string" || !VALID_PATTERN.test(p))) throw new Error(`delegation profile ${key} must be a list of tool patterns`)
    return v as string[]
  }
  const approvals = input.approvals
  if (approvals !== undefined && approvals !== "risky" && approvals !== "listed") throw new Error('delegation profile approvals must be "risky" or "listed"')
  return {
    ...(list("allowedToolPatterns") ? { allowedToolPatterns: list("allowedToolPatterns") } : {}),
    ...(list("deniedToolPatterns") ? { deniedToolPatterns: list("deniedToolPatterns") } : {}),
    ...(list("approvalRequiredToolPatterns") ? { approvalRequiredToolPatterns: list("approvalRequiredToolPatterns") } : {}),
    ...(approvals ? { approvals } : {}),
  }
}

/** Whether the profile lets the task see and use this tool at all (no approval question). */
export function isVisible(profile: Profile, toolName: string): boolean {
  if (matchesAnyPattern(toolName, profile.deniedToolPatterns ?? [])) return false
  const allowed = profile.allowedToolPatterns ?? []
  return allowed.length === 0 || matchesAnyPattern(toolName, allowed)
}

/** The decision for one call of `toolName` (a Keystone dynamic tool name, `<namespace>__<tool>`). */
export function decide(profile: Profile, toolName: string): Decision {
  if (!isVisible(profile, toolName)) return { effect: "deny", reason: "not allowed by this delegation's profile" }
  if (matchesAnyPattern(toolName, profile.approvalRequiredToolPatterns ?? [])) return { effect: "approve", reason: "listed as needing approval" }
  if ((profile.approvals ?? "risky") === "risky") {
    const risk = toolRisk(toolName)
    if (risk !== undefined) return { effect: "approve", reason: risk }
  }
  return { effect: "allow" }
}

// ---- Risk words, copied from CAS src/core/domain/tool-risk.ts and coding-delegate-reach.ts ----

/** CAS READ_VERB. */
const READ_VERB =
  /(^|[-_])(get|find|list|query|status|info|overview|explain|catalog|catalogue|providers|types|ref_data|summary|history|diff|usage|search|count|exists|hierarchy|lineage|tree|read|view|preview|check|describe)([-_]|$)/i
/** CAS WRITE_VERB. */
const WRITE_VERB =
  /(^|[-_])(create|update|save|delete|mutate|add|set|remove|start|publish|grant|transition|upload|send|reset|cancel|retry|disable|enable|onboard|register|configure|rollback|copy|move|rename|pin|break|attach|complete|assign|submit|approve|reject|import|export|sync|flush|clone|activate|deactivate)([-_]|$)/i
/** CAS DANGEROUS_TOOL_PATTERN (runs code or commands). */
const DANGEROUS = /(^|[-_])(python|shell|exec|eval|evaluate|spawn|bash|powershell|subprocess|run_code|execute_code)([-_]|$)/i
/** CAS EGRESS_WORD (sends data out), on `_`, `-` and `.` boundaries. */
const EGRESS = /(^|[-_.])(web|websearch|fetch|http|https|url|browser|playwright|publish|present|html|webhook|email|mail|send|post|upload|share|tavily|internet)([-_.]|$)/i
/** CAS RAG_READ_TOOL_NAMES: RAG reads whose names have no read verb. */
const RAG_READ = new Set([
  "rag_graph_explain",
  "rag_graph_hubs",
  "rag_graph_neighbors",
  "rag_graph_source_snippet",
  "rag_ask",
  "rag_search",
  "rag_discover_related",
  "rag_match_skills",
  "rag_agent_bootstrap",
  "rag_feedback_for_source",
  "rag_list_collections",
  "rag_search_repos",
  "rag_list_mirrors",
  "rag_get_articles",
  "rag_list_skills",
  "rag_get_skill",
  "rag_get_receipt",
])

/** The upstream tool name: Keystone dynamic names are `<namespace>__<tool>` (CAS extractBaseToolName). */
export const baseToolName = (toolName: string) => (toolName.includes("__") ? toolName.slice(toolName.lastIndexOf("__") + 2) : toolName)

/**
 * Why a tool needs an approval under the "risky" default, or undefined for a plain read.
 * Fail-closed like CAS isWriteTool: a name with no read verb counts as a change.
 */
export function toolRisk(toolName: string): string | undefined {
  const base = baseToolName(toolName)
  if (DANGEROUS.test(base)) return "it can run code or commands"
  if (EGRESS.test(base)) return "it can send data out"
  if (WRITE_VERB.test(base)) return "it can change something"
  if (RAG_READ.has(base) || READ_VERB.test(base)) return undefined
  return "it is not recognised as a read, so it is treated as a change"
}
