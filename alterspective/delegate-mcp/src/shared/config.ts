// Bridge configuration: where things live on the host and what the box may reach.
// Defaults encode the owner's decisions of 2026-10-01 (README.md): Docker box,
// egress = Keystone + Synapse + npm/PyPI (through caches), chosen Keystone connections only (R4-01).
import os from "node:os"
import path from "node:path"
import { DEFAULT_KEYSTONE, connectionPathPattern, readKeystoneSet, type KeystoneSet } from "./keystone.ts"

export type BridgeConfig = {
  /** Host folder for lock-free state: logs, hand-off bundles, profile. Never mounted rw into the box except `handoff`. */
  home: string
  /** Owner repos a session may be started from (normalised, case-insensitive on Windows). */
  roots: string[]
  /** Keystone origin. */
  keystoneOrigin: string
  /**
   * The default Keystone connection ids (`/mcp/c/<id>`) the box may use. A set saved by
   * oc_server_restart {keystone} in the bridge home wins over this (keystone.ts). Never /mcp/dynamic.
   */
  keystoneConnections: string[]
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
  const keystone = env.OPENCODE_DELEGATE_KEYSTONE?.split(",").map((id) => id.trim()).filter(Boolean)
  return {
    home,
    roots: (env.OPENCODE_DELEGATE_ROOTS ?? "C:\\GitHub").split(";").filter(Boolean),
    keystoneOrigin: "https://identity.alterspective.com.au",
    keystoneConnections: keystone ?? [...DEFAULT_KEYSTONE],
    egressHosts: ["identity.alterspective.com.au", "synapse2-api.alterspective.com.au"],
    boxEnv: ["SYNAPSE_API_KEY"],
    project: "opencode-delegate",
    image: "opencode-delegate-box",
  }
}

/** The box-wide Keystone set right now (saved choice, else the config default). Throws profile_invalid on a damaged file. */
export function currentKeystone(config: Pick<BridgeConfig, "home" | "keystoneConnections">): KeystoneSet {
  return readKeystoneSet(config.home, config.keystoneConnections)
}

/** `config` with keystoneConnections replaced by the box-wide set in force now. */
export function effectiveConfig<C extends Pick<BridgeConfig, "home" | "keystoneConnections">>(config: C): C {
  return { ...config, keystoneConnections: currentKeystone(config).connections }
}

/** Where the bridge writes front's generated server config (mounted read-only into `front`). */
export const frontDir = (config: Pick<BridgeConfig, "home">) => path.join(config.home, "front")

/**
 * The OPENCODE_MCP_ALLOW policy the box runs with (enforced by the fork patch, §3.4): Keystone's
 * origin and exactly the chosen `/mcp/c/<id>` paths. No `/mcp/dynamic`. With no connections chosen
 * the rule list is empty, which the patch reads as "refuse every entry".
 * `keystoneConnections` must already be the effective set (effectiveConfig).
 */
export function mcpAllowPolicy(config: Pick<BridgeConfig, "keystoneOrigin" | "keystoneConnections">) {
  const pattern = connectionPathPattern(config.keystoneConnections)
  return JSON.stringify({ remote: pattern ? [{ origin: config.keystoneOrigin, path: pattern }] : [] })
}
