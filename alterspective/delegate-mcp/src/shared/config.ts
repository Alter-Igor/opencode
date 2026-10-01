// Bridge configuration: where things live on the host and what the box may reach.
// Defaults encode the owner's decisions of 2026-10-01 (README.md): Docker box,
// egress = Keystone + Synapse + npm/PyPI (through caches), Keystone-only MCP.
import os from "node:os"
import path from "node:path"

export type BridgeConfig = {
  /** Host folder for lock-free state: logs, hand-off bundles, profile. Never mounted rw into the box except `handoff`. */
  home: string
  /** Owner repos a session may be started from (normalised, case-insensitive on Windows). */
  roots: string[]
  /** Keystone origin and the connections pinned in addition to /mcp/dynamic. */
  keystoneOrigin: string
  pinnedConnections: string[]
  /** Hosts the front proxy serves, each with one fixed upstream (exact names). */
  egressHosts: string[]
  /** Host env vars copied into the box, one by one. Nothing else crosses. */
  boxEnv: string[]
  /** Docker names. */
  project: string
  image: string
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const home = env.OPENCODE_DELEGATE_HOME ?? path.join(os.homedir(), ".local", "share", "opencode-delegate")
  return {
    home,
    roots: (env.OPENCODE_DELEGATE_ROOTS ?? "C:\\GitHub").split(";").filter(Boolean),
    keystoneOrigin: "https://identity.alterspective.com.au",
    pinnedConnections: (env.OPENCODE_DELEGATE_PINNED ?? "").split(",").filter(Boolean),
    egressHosts: ["identity.alterspective.com.au", "synapse2-api.alterspective.com.au"],
    boxEnv: ["SYNAPSE_API_KEY"],
    project: "opencode-delegate",
    image: "opencode-delegate-box",
  }
}

/** The OPENCODE_MCP_ALLOW policy the box runs with (enforced by the fork patch, §3.4). */
export function mcpAllowPolicy(config: BridgeConfig) {
  return JSON.stringify({ remote: [{ origin: config.keystoneOrigin, path: "^/mcp/(dynamic|c/[A-Za-z0-9_-]+)$" }] })
}
