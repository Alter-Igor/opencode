// MOD-01 T1.3: what the `docker compose up` child is given. The server password lives only in
// the bridge's memory and in this child env (and so the container). It is never written to a
// file or logged. Box env vars are listed in the override file by NAME only.
import path from "node:path"
import { frontDir, mcpAllowPolicy, type BridgeConfig } from "../shared/config.ts"
import { DelegateError } from "../shared/errors.ts"
import { childEnv } from "./docker.ts"
import type { BuiltProfile } from "./profile.ts"

/** front's generated servers file (review R4-01) and its sha256 (the front-config label). */
export type FrontFiles = { servers: string; hash: string }

export const PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD"
export const MCP_ALLOW_ENV = "OPENCODE_MCP_ALLOW"
/** Container env the supervisor reads back from `docker inspect`; everything else is discarded unread. */
export const INSPECT_ENV = [PASSWORD_ENV, MCP_ALLOW_ENV]
/**
 * MOD-05 inbox sidecar admin token: generated per box start like the password, given to the
 * `docker compose up` child and so to the INBOX container only (never the box), and read back by
 * other bridges with `docker inspect <project>-inbox`. Never written to a file or logged.
 */
export const INBOX_ADMIN_TOKEN_ENV = "INBOX_ADMIN_TOKEN"
/** Label on the inbox container: the 127.0.0.1 host port of its admin routes (published by gate-admin, W2C-05, R3-02). */
export const INBOX_PORT_LABEL = "com.alterspective.opencode-delegate.inbox-port"
export type InboxStart = { port: number; token: string }
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function paths(config: BridgeConfig) {
  return {
    profile: path.join(config.home, "profile"),
    handoff: path.join(config.home, "handoff"),
    leases: path.join(config.home, "leases"),
    startLock: path.join(config.home, "start.lock"),
    boxEnvOverride: path.join(config.home, "compose.box-env.yaml"),
    /** Generated front config, mounted read-only into front (never into the box). */
    front: frontDir(config),
  }
}

/** The box container is named after the compose project (compose.yaml `container_name`). */
export function containerName(config: Pick<BridgeConfig, "project">): string {
  return config.project
}

/**
 * The services next to the box that are built from docker/ (review N-9). Each one's image is
 * `${OCD_IMAGE}-<service>` and its container `<project>-<service>` carries the image label, so a
 * running set built from another checkout is caught on reuse.
 */
export const SIBLING_SERVICES = ["front", "npm-cache", "pypi-cache", "inbox"] as const

export function siblingContainers(config: Pick<BridgeConfig, "project">): Array<{ service: string; container: string }> {
  return SIBLING_SERVICES.map((service) => ({ service, container: `${containerName(config)}-${service}` }))
}

/**
 * Names the box env list may never carry (W2C-14): the override file is merged after
 * compose.yaml, so a listed name would replace what compose.yaml sets for the box (the inbox URL,
 * front's CA, the OpenCode lock-down flags, the package indexes) with a host value, or put a
 * bridge-only secret into the box. Proxy names stay reserved: the box has no proxy (R3-01) and a
 * host value must not give it one. Matched without regard to case.
 */
/** TLS trust settings: the box trusts front's internal CA only, and nothing may turn checks off (R3-01). */
const TLS_TRUST_ENV = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "GIT_SSL_NO_VERIFY", "REQUESTS_CA_BUNDLE", "NODE_TLS_REJECT_UNAUTHORIZED"]
const RESERVED_EXACT = new Set(["INBOX_ADMIN_TOKEN", "HOME", "PATH", "BUN_CONFIG_REGISTRY", ...TLS_TRUST_ENV])
const RESERVED_PREFIX = ["OCD_", "OPENCODE_", "INBOX_", "XDG_", "NPM_CONFIG_", "PIP_", "UV_"]
const RESERVED_SUFFIX = ["_PROXY"]

export function isReservedBoxEnv(name: string): boolean {
  const upper = name.toUpperCase()
  return RESERVED_EXACT.has(upper) || RESERVED_PREFIX.some((prefix) => upper.startsWith(prefix)) || RESERVED_SUFFIX.some((suffix) => upper.endsWith(suffix))
}

/** Compose override listing the approved box env vars by NAME only (values come from the child env). */
export function boxEnvOverride(names: string[]): string {
  for (const name of names) {
    if (!ENV_NAME.test(name))
      throw new DelegateError("invalid_input", "The approved box env list has an invalid variable name.", "Fix the bridge configuration (boxEnv).", `name=${name.slice(0, 40)}`)
    if (isReservedBoxEnv(name))
      throw new DelegateError("invalid_input", "The approved box env list names a variable the sandbox sets itself.", "Remove it from the bridge configuration (boxEnv).", `name=${name.slice(0, 40)}`)
  }
  if (names.length === 0) return "services: {}\n"
  return ["services:", "  box:", "    environment:", ...names.map((name) => `      ${name}:`)].join("\n") + "\n"
}

export type ComposeInputs = {
  config: BridgeConfig
  hostEnv: NodeJS.ProcessEnv
  image: string
  opencodeVersion: string
}

/** front's upstream DNS resolver (compose.yaml front), passed on only when the owner set it; not a secret. */
export const FRONT_RESOLVER_ENV = "OCD_FRONT_RESOLVER"
function frontEnv(hostEnv: NodeJS.ProcessEnv): Record<string, string> {
  const value = hostEnv[FRONT_RESOLVER_ENV]
  return value ? { [FRONT_RESOLVER_ENV]: value } : {}
}

/** Values of the approved box env vars present on the host (for the child env and for redaction). */
export function approvedValues(inputs: Pick<ComposeInputs, "config" | "hostEnv">): Record<string, string> {
  const approved: Record<string, string> = {}
  for (const name of inputs.config.boxEnv) {
    const value = inputs.hostEnv[name]
    if (value !== undefined) approved[name] = value
  }
  return approved
}

/**
 * Env of the `docker compose down` child (review N-1). `down` loads the same -f files as `up`,
 * so the required interpolation variables must be set; none of them is a secret, and neither the
 * password nor any approved key is passed. Placeholders stand in for values only `up` needs.
 */
export function composeDownEnv(inputs: ComposeInputs): Record<string, string> {
  const dirs = paths(inputs.config)
  return childEnv(inputs.hostEnv, {
    OCD_IMAGE: inputs.image,
    OCD_OPENCODE_VERSION: inputs.opencodeVersion,
    OCD_PROFILE_HASH: "down",
    OCD_PORT: "0",
    OCD_INBOX_PORT: "0",
    OCD_CONTAINER: containerName(inputs.config),
    OCD_PROFILE_DIR: dirs.profile,
    OCD_HANDOFF_DIR: dirs.handoff,
    OCD_FRONT_DIR: dirs.front,
    OCD_FRONT_HASH: "down",
    ...frontEnv(inputs.hostEnv),
  })
}

/** What one `up` is started with. `front` is the generated servers file for the same Keystone set as the policy. */
export type StartValues = { built: BuiltProfile; port: number; password: string; front: FrontFiles; inbox?: InboxStart }

/**
 * Env of the `docker compose up` child: CLI essentials + OCD_* + password + approved keys (+ inbox port/token).
 * `inputs.config.keystoneConnections` must be the effective set (effectiveConfig): it makes the MCP policy.
 */
export function composeEnv(inputs: ComposeInputs, start: StartValues): Record<string, string> {
  const dirs = paths(inputs.config)
  const inboxEnv: Record<string, string> = start.inbox ? { OCD_INBOX_PORT: String(start.inbox.port), [INBOX_ADMIN_TOKEN_ENV]: start.inbox.token } : {}
  return childEnv(inputs.hostEnv, {
    ...approvedValues(inputs),
    OCD_IMAGE: inputs.image,
    OCD_OPENCODE_VERSION: inputs.opencodeVersion,
    OCD_PROFILE_HASH: start.built.hash,
    OCD_PORT: String(start.port),
    OCD_CONTAINER: containerName(inputs.config),
    OCD_PROFILE_DIR: dirs.profile,
    OCD_HANDOFF_DIR: dirs.handoff,
    OCD_FRONT_DIR: dirs.front,
    OCD_FRONT_HASH: start.front.hash,
    ...frontEnv(inputs.hostEnv),
    [MCP_ALLOW_ENV]: mcpAllowPolicy(inputs.config),
    [PASSWORD_ENV]: start.password,
    ...inboxEnv,
  })
}
