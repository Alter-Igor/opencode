// MOD-02: oc_doctor's egress check (review R3-01). It reads the files the sandbox is started from
// (this checkout's docker/ folder) and says whether the egress control they describe is the
// fixed-upstream TLS front generated from config.egressHosts, with no CONNECT proxy left, that
// front verifies its upstreams (upstream.conf), and that the box sits on the internal `sealed`
// network only (R4-05).
// It checks CONFIGURATION, not traffic: the live red/green proof is test/egress-live.test.ts
// (OCD_LIVE_EGRESS=1). Never throws: an unreadable file is a failed check with a reason.
import { readFileSync } from "node:fs"
import path from "node:path"
import { FRONT_HOSTS_FILE, FRONT_SERVERS_FILE, egressHostList, frontHosts, frontServers } from "./egress.ts"

export const DOCKER_DIR = path.join(import.meta.dir, "..", "..", "docker")

export type EgressCheck = {
  ok: boolean
  control: "tls-front"
  source: "configuration"
  /** docker/front/servers.conf and hosts.txt equal what config.egressHosts generates. */
  frontConfigMatches: boolean
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

type Service = { networks?: unknown; environment?: unknown; image?: unknown; build?: unknown }
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

function frontMatches(dir: string, hosts: readonly string[], problems: string[]): boolean {
  let expected: [string, string][]
  try {
    expected = [[FRONT_SERVERS_FILE, frontServers(hosts)], [FRONT_HOSTS_FILE, frontHosts(hosts)]]
  } catch (error) {
    problems.push(`config.egressHosts refused: ${error instanceof Error ? error.message : "invalid"}`)
    return false
  }
  let ok = true
  for (const [file, text] of expected) {
    if (readText(dir, file, problems) === text) continue
    problems.push(`${file} is not the generated file for config.egressHosts (run: bun src/guard/egress.ts)`)
    ok = false
  }
  return ok
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

/** The egress control the sandbox's files describe, for `hosts` (config.egressHosts). */
export function checkEgress(hosts: readonly string[], dir: string = DOCKER_DIR): EgressCheck {
  const problems: string[] = []
  const frontConfigMatches = frontMatches(dir, hosts, problems)
  const upstreamTls = upstreamTlsVerified(dir, problems)
  const compose = parseCompose(dir, problems)
  const aliases = compose ? aliasesMatch(compose, hosts, problems) : false
  if (compose && !compose.services?.front) problems.push("compose.yaml has no `front` service")
  const connectProxy = compose ? hasConnectProxy(compose, problems) : true
  const sealed = compose ? boxSealed(compose, problems) : false
  const ok = frontConfigMatches && upstreamTls && aliases && !connectProxy && sealed && compose?.services?.front !== undefined
  return { ok, control: "tls-front", source: "configuration", frontConfigMatches, aliasesMatch: aliases, connectProxy, upstreamTlsVerified: upstreamTls, boxSealed: sealed, problems }
}
