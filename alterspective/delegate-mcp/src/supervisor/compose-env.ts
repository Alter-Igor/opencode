// MOD-01 T1.3: what the `docker compose up` child is given. The server password lives only in
// the bridge's memory and in this child env (and so the container). It is never written to a
// file or logged. Box env vars are listed in the override file by NAME only.
import path from "node:path"
import { mcpAllowPolicy, type BridgeConfig } from "../shared/config.ts"
import { DelegateError } from "../shared/errors.ts"
import { childEnv } from "./docker.ts"
import type { BuiltProfile } from "./profile.ts"

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
/** Label on the inbox container: the 127.0.0.1 host port of its admin routes. */
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
export const SIBLING_SERVICES = ["egress", "npm-cache", "pypi-cache", "inbox"] as const

export function siblingContainers(config: Pick<BridgeConfig, "project">): Array<{ service: string; container: string }> {
  return SIBLING_SERVICES.map((service) => ({ service, container: `${containerName(config)}-${service}` }))
}

/** Compose override listing the approved box env vars by NAME only (values come from the child env). */
export function boxEnvOverride(names: string[]): string {
  for (const name of names)
    if (!ENV_NAME.test(name))
      throw new DelegateError("invalid_input", "The approved box env list has an invalid variable name.", "Fix the bridge configuration (boxEnv).", `name=${name.slice(0, 40)}`)
  if (names.length === 0) return "services: {}\n"
  return ["services:", "  box:", "    environment:", ...names.map((name) => `      ${name}:`)].join("\n") + "\n"
}

export type ComposeInputs = {
  config: BridgeConfig
  hostEnv: NodeJS.ProcessEnv
  image: string
  opencodeVersion: string
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
  })
}

/** Env of the `docker compose up` child: CLI essentials + OCD_* + password + approved keys (+ inbox port/token). */
export function composeEnv(inputs: ComposeInputs, built: BuiltProfile, port: number, password: string, inbox?: InboxStart): Record<string, string> {
  const dirs = paths(inputs.config)
  const inboxEnv: Record<string, string> = inbox ? { OCD_INBOX_PORT: String(inbox.port), [INBOX_ADMIN_TOKEN_ENV]: inbox.token } : {}
  return childEnv(inputs.hostEnv, {
    ...approvedValues(inputs),
    OCD_IMAGE: inputs.image,
    OCD_OPENCODE_VERSION: inputs.opencodeVersion,
    OCD_PROFILE_HASH: built.hash,
    OCD_PORT: String(port),
    OCD_CONTAINER: containerName(inputs.config),
    OCD_PROFILE_DIR: dirs.profile,
    OCD_HANDOFF_DIR: dirs.handoff,
    [MCP_ALLOW_ENV]: mcpAllowPolicy(inputs.config),
    [PASSWORD_ENV]: password,
    ...inboxEnv,
  })
}
