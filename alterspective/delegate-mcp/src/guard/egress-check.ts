// MOD-02: oc_doctor's egress check (review R3-01). It reads the files the sandbox is started from
// (this checkout's docker/ folder, and the servers file the bridge generated into its home) and
// says whether the egress control they describe is the fixed-upstream TLS front generated from
// config.egressHosts and the chosen Keystone connections (R4-01: only their Keystone paths), that
// front reads that file read-only, with no CONNECT proxy left, that front verifies its upstreams
// (upstream.conf), and that the box sits on the internal `sealed` network only (R4-05).
// It checks CONFIGURATION, not traffic: the live red/green proof is test/egress-live.test.ts
// (OCD_LIVE_EGRESS=1). Never throws: an unreadable file is a failed check with a reason.
import { readFileSync } from "node:fs"
import path from "node:path"
import { FRONT_GENERATED_MOUNT, FRONT_HOSTS_FILE, FRONT_SERVERS_NAME, egressHostList, frontHosts, frontServers, withDelegationProfile, type FrontKeystone } from "./egress.ts"
import { identityPaths } from "./egress-identity.ts"
import { frontDir, type BridgeConfig } from "../shared/config.ts"

export const DOCKER_DIR = path.join(import.meta.dir, "..", "..", "docker")

/**
 * What the front should be generated from: the egress hosts, the Keystone host + chosen set, the
 * bridge's front folder, and (#104/#115) the delegation profile, whose digest the file carries when
 * the dynamic connection is chosen.
 */
export type EgressInput = { hosts: readonly string[]; keystone: FrontKeystone; frontDir: string; dynamicProfile: string }

export type EgressCheck = {
  ok: boolean
  control: "tls-front"
  source: "configuration"
  /** The chosen Keystone connections the front was checked against (R4-01). */
  keystoneConnections: string[]
  /** The only Keystone paths front forwards for that set; everything else on Keystone gets 403. */
  keystonePaths: string[]
  /** <home>/front/servers.conf and docker/front/hosts.txt equal what the hosts and the Keystone set generate. */
  frontConfigMatches: boolean
  /** compose mounts the source folder read-only, and nginx.conf includes the checked runtime generation. */
  frontMountReadOnly: boolean
  /** front's network aliases on `sealed` are exactly the allowed hosts. */
  aliasesMatch: boolean
  /** A CONNECT proxy (the old tinyproxy `egress`) or a proxy variable in the box env is present. */
  connectProxy: boolean
  /** docker/front/upstream.conf verifies the upstream certificate and forces SNI (R4-05). */
  upstreamTlsVerified: boolean
  /** `sealed` is an internal network and the box is on it and nothing else (R4-05). */
  boxSealed: boolean
  problems: string[]
}

type Service = { networks?: unknown; environment?: unknown; image?: unknown; build?: unknown; volumes?: unknown }
type Compose = { services?: Record<string, Service>; networks?: Record<string, { internal?: unknown } | null> }

/** Shared upstream settings; included by every generated server in servers.conf. */
export const FRONT_UPSTREAM_FILE = "front/upstream.conf"
/** Without these, front would accept any certificate, or send no SNI, to its fixed upstream. */
const UPSTREAM_TLS = ["proxy_ssl_verify", "proxy_ssl_server_name"] as const

const lf = (text: string) => text.replaceAll("\r\n", "\n")

function readText(dir: string, file: string, problems: string[]): string | undefined {
  try {
    return lf(readFileSync(path.join(dir, file), "utf8"))
  } catch (error) {
    problems.push(`${file} unreadable (${(error as NodeJS.ErrnoException).code ?? "error"})`)
    return undefined
  }
}

function frontMatches(dir: string, input: EgressInput, problems: string[]): boolean {
  let servers: string
  let hosts: string
  try {
    servers = withDelegationProfile(frontServers(input.hosts, input.keystone), input.keystone.connections, input.dynamicProfile)
    hosts = frontHosts(input.hosts)
  } catch (error) {
    problems.push(`config.egressHosts or the Keystone set refused: ${error instanceof Error ? error.message : "invalid"}`)
    return false
  }
  let ok = true
  if (readText(dir, FRONT_HOSTS_FILE, problems) !== hosts) {
    problems.push(`${FRONT_HOSTS_FILE} is not the generated file for config.egressHosts (run: bun src/guard/egress.ts)`)
    ok = false
  }
  if (readText(input.frontDir, FRONT_SERVERS_NAME, problems) !== servers) {
    problems.push(`the bridge's ${FRONT_SERVERS_NAME} is not the one generated for the egress hosts and the chosen Keystone set (restart the sandbox with oc_server_restart)`)
    ok = false
  }
  return ok
}

/** front gets generated sources read-only; nginx consumes front-reload's checked snapshots. */
function frontMountReadOnly(dir: string, front: Service | undefined, problems: string[]): boolean {
  const volumes = Array.isArray(front?.volumes) ? front.volumes.map(String) : []
  const mounted = volumes.some((volume) => volume.endsWith(`:${FRONT_GENERATED_MOUNT}:ro`))
  const included = (readText(dir, "front/nginx.conf", problems) ?? "").includes("include /tmp/front/current.conf;")
  if (!mounted) problems.push(`compose.yaml does not mount the generated front folder read-only at ${FRONT_GENERATED_MOUNT}`)
  if (!included) problems.push("front/nginx.conf does not include the checked /tmp/front/current.conf")
  return mounted && included
}

function aliasesOf(front: Service | undefined): string[] {
  const networks = front?.networks
  if (!networks || typeof networks !== "object" || Array.isArray(networks)) return []
  const aliases = (networks as Record<string, { aliases?: unknown } | null>).sealed?.aliases
  return Array.isArray(aliases) ? aliases.map(String) : []
}

function aliasesMatch(compose: Compose, hosts: readonly string[], problems: string[]): boolean {
  let wanted: string[]
  try {
    wanted = egressHostList(hosts).sort()
  } catch {
    return false
  }
  const got = aliasesOf(compose.services?.front).map((alias) => alias.toLowerCase()).sort()
  const same = got.length === wanted.length && got.every((alias, index) => alias === wanted[index])
  if (!same) problems.push(`front's sealed aliases [${got.join(", ")}] differ from config.egressHosts`)
  return same
}

function envNames(environment: unknown): string[] {
  if (Array.isArray(environment)) return environment.map((entry) => String(entry).split("=")[0] ?? "")
  return environment && typeof environment === "object" ? Object.keys(environment) : []
}

function hasConnectProxy(compose: Compose, problems: string[]): boolean {
  const services = compose.services ?? {}
  const found: string[] = []
  if (services.egress) found.push("an `egress` service")
  for (const [name, service] of Object.entries(services))
    if (/tinyproxy|squid|privoxy/i.test(JSON.stringify([service.image, service.build]))) found.push(`a proxy image in ${name}`)
  const proxyVars = envNames(services.box?.environment).filter((env) => env.toUpperCase().endsWith("_PROXY"))
  if (proxyVars.length) found.push(`box env ${proxyVars.join(", ")}`)
  if (found.length) problems.push(`CONNECT proxy still configured: ${found.join("; ")}`)
  return found.length > 0
}

function parseCompose(dir: string, problems: string[]): Compose | undefined {
  const text = readText(dir, "compose.yaml", problems)
  if (text === undefined) return undefined
  try {
    return Bun.YAML.parse(text) as Compose
  } catch {
    problems.push("compose.yaml does not parse")
    return undefined
  }
}

/** Every `name value;` directive in an nginx file, comments removed (values lower-cased). */
function directives(text: string): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const statements = text.replace(/#.*$/gm, "").split(/[;{}]/)
  for (const statement of statements) {
    const [name, ...args] = statement.trim().split(/\s+/)
    if (!name) continue
    found.set(name, [...(found.get(name) ?? []), args.join(" ").toLowerCase()])
  }
  return found
}

/** Each UPSTREAM_TLS directive is present, and every occurrence of it is `on` (a later `off` wins in nginx). */
function upstreamTlsVerified(dir: string, problems: string[]): boolean {
  const text = readText(dir, FRONT_UPSTREAM_FILE, problems)
  if (text === undefined) return false
  const found = directives(text)
  const wrong = UPSTREAM_TLS.filter((name) => {
    const values = found.get(name) ?? []
    return values.length === 0 || values.some((value) => value !== "on")
  })
  if (wrong.length) problems.push(`${FRONT_UPSTREAM_FILE} does not set ${wrong.map((name) => `\`${name} on\``).join(" and ")} (and nothing else)`)
  return wrong.length === 0
}

function networksOf(service: Service | undefined): string[] {
  const networks = service?.networks
  if (Array.isArray(networks)) return networks.map(String)
  return networks && typeof networks === "object" ? Object.keys(networks) : []
}

/** The box is on `sealed` only, and `sealed` has no default route (`internal: true`). */
function boxSealed(compose: Compose, problems: string[]): boolean {
  const internal = compose.networks?.sealed?.internal === true
  if (!internal) problems.push("compose.yaml network `sealed` is not `internal: true`")
  const boxNetworks = networksOf(compose.services?.box)
  const only = boxNetworks.length === 1 && boxNetworks[0] === "sealed"
  if (!only) problems.push(`the box is on [${boxNetworks.join(", ")}], not on \`sealed\` only`)
  return internal && only
}

function pathsOf(input: EgressInput, problems: string[]): string[] {
  try {
    return identityPaths(input.keystone.connections).map((allowed) => allowed.path)
  } catch {
    problems.push("the chosen Keystone set is not valid")
    return []
  }
}

/** The egress control the sandbox's files describe, for the egress hosts and the chosen Keystone set. */
export function checkEgress(input: EgressInput, dir: string = DOCKER_DIR): EgressCheck {
  const problems: string[] = []
  const keystonePaths = pathsOf(input, problems)
  const frontConfigMatches = frontMatches(dir, input, problems)
  const upstreamTls = upstreamTlsVerified(dir, problems)
  const compose = parseCompose(dir, problems)
  const aliases = compose ? aliasesMatch(compose, input.hosts, problems) : false
  if (compose && !compose.services?.front) problems.push("compose.yaml has no `front` service")
  const mountRo = compose ? frontMountReadOnly(dir, compose.services?.front, problems) : false
  const connectProxy = compose ? hasConnectProxy(compose, problems) : true
  const sealed = compose ? boxSealed(compose, problems) : false
  const ok = frontConfigMatches && mountRo && upstreamTls && aliases && !connectProxy && sealed && compose?.services?.front !== undefined
  return {
    ok, control: "tls-front", source: "configuration", keystoneConnections: [...input.keystone.connections], keystonePaths,
    frontConfigMatches, frontMountReadOnly: mountRo, aliasesMatch: aliases, connectProxy, upstreamTlsVerified: upstreamTls, boxSealed: sealed, problems,
  }
}

/** The EgressInput for a config whose keystoneConnections is already the effective set (effectiveConfig). */
export function egressInput(config: Pick<BridgeConfig, "egressHosts" | "keystoneOrigin" | "keystoneConnections" | "home" | "dynamicProfile">): EgressInput {
  return {
    hosts: config.egressHosts,
    keystone: { host: new URL(config.keystoneOrigin).hostname, connections: config.keystoneConnections },
    frontDir: frontDir(config),
    dynamicProfile: config.dynamicProfile,
  }
}
