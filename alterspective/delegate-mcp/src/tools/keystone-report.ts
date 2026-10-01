// The box-wide Keystone set as tools report it (review R4-01): which connections the box may use,
// whether that is the saved choice or the default, and each entry's sign-in state when known.
// Shown by oc_doctor and oc_list_models; changed only by oc_server_restart {keystone}.
import { currentKeystone, type BridgeConfig } from "../shared/config.ts"
import { entryName, type KeystoneSource } from "../shared/keystone.ts"

export type KeystoneEntry = { id: string; name: string; status: string }
export type KeystoneReport =
  | { connections: string[]; source: KeystoneSource; entries?: KeystoneEntry[] }
  | { unavailable: string }

/**
 * The set in force now. `statuses` (entry name → GET /mcp status) adds each entry's state; a
 * chosen connection the box does not list is `missing`. Never throws: a damaged saved choice is
 * reported as unavailable (and every check that needs it fails closed elsewhere).
 */
export function keystoneReport(config: Pick<BridgeConfig, "home" | "keystoneConnections">, statuses?: ReadonlyMap<string, string>): KeystoneReport {
  try {
    const set = currentKeystone(config)
    if (!statuses) return { connections: set.connections, source: set.source }
    const entries = set.connections.map((id) => ({ id, name: entryName(id), status: statuses.get(entryName(id)) ?? "missing" }))
    return { connections: set.connections, source: set.source, entries }
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : "the saved Keystone choice could not be read" }
  }
}

/** One line for a tool summary, e.g. `Keystone: rag-global, github (default)`. */
export function keystoneLine(report: KeystoneReport): string {
  if ("unavailable" in report) return "Keystone services: UNAVAILABLE (saved choice damaged)"
  const list = report.connections.length ? report.connections.join(", ") : "none"
  return `Keystone services: ${list} (${report.source === "saved" ? "saved choice" : "default"})`
}
