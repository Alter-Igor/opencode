// The box-wide Keystone set as tools report it (review R4-01): which connections the box may use,
// whether that is the saved choice or the default, and each entry's sign-in state when known.
// Shown by oc_doctor and oc_list_models; changed only by oc_server_restart {keystone}.
// R5-03 / R5-04: also the owner's ceiling (launch env) and a warning for each high-risk id in the
// ceiling or the set: one connection can relay to many services (mail agents, admin tools, vault).
import { currentKeystone, type KeystoneConfig } from "../shared/config.ts"
import { entryName, type KeystoneSource } from "../shared/keystone.ts"
import { CEILING_ENV, ceilingOf, highRiskIds } from "../shared/keystone-policy.ts"

export type KeystoneEntry = { id: string; name: string; status: string }
type Limits = { ceiling: string[]; highRisk: string[]; warnings: string[] }
export type KeystoneReport =
  | ({ connections: string[]; source: KeystoneSource; entries?: KeystoneEntry[] } & Limits)
  | ({ unavailable: string } & Partial<Limits>)

/** The ceiling and the high-risk ids in it or in `connections`; empty when the ceiling itself is invalid. */
function limits(config: KeystoneConfig, connections: readonly string[]): Limits {
  let ceiling: string[]
  try {
    ceiling = ceilingOf(config)
  } catch {
    ceiling = []
  }
  const highRisk = highRiskIds([...new Set([...ceiling, ...connections])])
  const warnings = highRisk.length
    ? [`High-risk Keystone connection${highRisk.length === 1 ? "" : "s"} ${highRisk.join(", ")} ${highRisk.length === 1 ? "is" : "are"} allowed (${CEILING_ENV}) or chosen: one connection can relay to many services (mail, admin tools, secrets). Remove ${highRisk.length === 1 ? "it" : "them"} unless this scenario needs ${highRisk.length === 1 ? "it" : "them"}.`]
    : []
  return { ceiling, highRisk, warnings }
}

/**
 * The set in force now. `statuses` (entry name → GET /mcp status) adds each entry's state; a
 * chosen connection the box does not list is `missing`. Never throws: a damaged saved choice is
 * reported as unavailable (and every check that needs it fails closed elsewhere).
 */
export function keystoneReport(config: KeystoneConfig, statuses?: ReadonlyMap<string, string>): KeystoneReport {
  try {
    const set = currentKeystone(config)
    const base = { connections: set.connections, source: set.source, ...limits(config, set.connections) }
    if (!statuses) return base
    return { ...base, entries: set.connections.map((id) => ({ id, name: entryName(id), status: statuses.get(entryName(id)) ?? "missing" })) }
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : "the saved Keystone choice could not be read", ...limits(config, []) }
  }
}

/** One line for a tool summary, e.g. `Keystone: rag-global, github (default)`. */
export function keystoneLine(report: KeystoneReport): string {
  if ("unavailable" in report) return `Keystone services: UNAVAILABLE (${report.unavailable.slice(0, 160)})`
  const list = report.connections.length ? report.connections.join(", ") : "none"
  const risk = report.highRisk.length ? `; WARNING high-risk allowed or chosen: ${report.highRisk.join(", ")}` : ""
  return `Keystone services: ${list} (${report.source === "saved" ? "saved choice" : "default"}${risk})`
}
