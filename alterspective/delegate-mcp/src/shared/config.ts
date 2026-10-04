// Bridge configuration: where things live on the host and what the box may reach.
// Defaults encode the owner's decisions of 2026-10-01 (README.md): Docker box,
// egress = Keystone + Synapse + npm/PyPI (through caches), chosen Keystone connections only (R4-01).
import os from "node:os"
import path from "node:path"
import { DEFAULT_KEYSTONE, connectionPathPattern, readKeystoneSet, type KeystoneSet } from "./keystone.ts"
import { CEILING_ENV, DEFAULT_TOOL_DENY, TOOL_DENY_ENV, enforceCeiling, envList } from "./keystone-policy.ts"
import { DelegateError } from "./errors.ts"

/** #104: the owner's delegation profile for /mcp/dynamic (launch env; see BridgeConfig.dynamicProfile). */
export const DYNAMIC_PROFILE_ENV = "OPENCODE_DELEGATE_DYNAMIC_PROFILE"

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
  /**
   * The owner's ceiling (R5-03): the only connection ids any set may use. Read once at bridge start
   * from OPENCODE_DELEGATE_KEYSTONE_ALLOWED, never from a tool call. Unset: the default set above.
   */
  keystoneAllowed?: string[]
  /** `ks-<id>_<tool>` names denied in the box profile and every session (R5-02; convenience, not a wall). */
  keystoneToolDeny: string[]
  /**
   * #104: the delegation profile the gate enforces on /mcp/dynamic (JSON, mcp-gate/src/policy.ts),
   * from OPENCODE_DELEGATE_DYNAMIC_PROFILE at bridge start, never from a tool call. Empty: the
   * default profile (every tool the owner can reach; risky tools wait for an approval).
   */
  dynamicProfile: string
  /** Hosts the front proxy serves, each with one fixed upstream (exact names). */
  egressHosts: string[]
  /**
   * Host env vars copied into the box, one by one. Nothing else crosses. Empty by default (WS2 #48):
   * the box holds no Synapse credential; front sets the owner's delegated token (src/synapse).
   */
  boxEnv: string[]
  /** Docker names. `project` is the compose project (OPENCODE_DELEGATE_PROJECT); the box container is named after it. */
  project: string
  image: string
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const home = env.OPENCODE_DELEGATE_HOME ?? path.join(os.homedir(), ".local", "share", "opencode-delegate")
  const keystone = envList(env.OPENCODE_DELEGATE_KEYSTONE)
  const allowed = envList(env[CEILING_ENV])
  return {
    home,
    roots: (env.OPENCODE_DELEGATE_ROOTS ?? "C:\\GitHub").split(";").filter(Boolean),
    keystoneOrigin: "https://identity.alterspective.com.au",
    keystoneConnections: keystone ?? [...DEFAULT_KEYSTONE],
    ...(allowed ? { keystoneAllowed: allowed } : {}),
    keystoneToolDeny: envList(env[TOOL_DENY_ENV]) ?? [...DEFAULT_TOOL_DENY],
    dynamicProfile: (env[DYNAMIC_PROFILE_ENV] ?? "").trim(),
    egressHosts: ["identity.alterspective.com.au", "synapse2-api.alterspective.com.au"],
    boxEnv: [],
    project: projectName(env.OPENCODE_DELEGATE_PROJECT),
    image: "opencode-delegate-box",
  }
}

export const DEFAULT_PROJECT = "opencode-delegate"
/** A compose project name (and so the box container name): like a bridge name, starting with a letter or digit. */
export const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

/** OPENCODE_DELEGATE_PROJECT, checked; unset or empty is the default project. */
export function projectName(value: string | undefined): string {
  if (value === undefined || value === "") return DEFAULT_PROJECT
  if (!PROJECT_RE.test(value)) throw new DelegateError("invalid_input", "OPENCODE_DELEGATE_PROJECT is not a valid project name.", "Use 1-40 characters: a-z, 0-9 and '-', starting with a letter or digit.")
  return value
}

export type KeystoneConfig = Pick<BridgeConfig, "home" | "keystoneConnections" | "keystoneAllowed">

/**
 * The box-wide Keystone set right now (saved choice, else the config default). Throws
 * profile_invalid on a damaged file, and policy_violation when the set leaves the owner's ceiling
 * (R5-03: a saved set is only as trusted as the tool call that saved it).
 */
export function currentKeystone(config: KeystoneConfig): KeystoneSet {
  const set = readKeystoneSet(config.home, config.keystoneConnections)
  enforceCeiling(set.connections, config)
  return set
}

/** `config` with keystoneConnections replaced by the box-wide set in force now. */
export function effectiveConfig<C extends KeystoneConfig>(config: C): C {
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
