// Live red/green proof for review R3-01 (and C-6 DNS, R4-04). Needs Docker and internet, so it runs
// only with OCD_LIVE_EGRESS=1. It starts the REAL `front` service from docker/compose.yaml plus
// three sealed probes (docker/front/live/probe.yaml) under a throwaway project, and always runs
// `down -v`. One probe runs the REAL box image: OCD_LIVE_BOX_IMAGE if set, else the image this
// checkout's bridge would run (identity.ts), built first if it is missing, exactly as the bridge
// would build it. That image is kept (it is the bridge's own); the throwaway front image is removed.
// Only public, read-only GETs, unauthenticated requests and bare TCP connects are sent; never credentials.
// R4-01 (h): front's Keystone server is generated for the default Keystone set and probed with
// path tricks; only the chosen connections' paths may reach Keystone.
//   OCD_LIVE_EGRESS=1 bun test test/egress-live.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { frontConfigHash, frontServersFor } from "../src/guard/egress.ts"
import { KEYSTONE_OAUTH_PATHS } from "../src/guard/egress-identity.ts"
import { defaultConfig } from "../src/shared/config.ts"
import { buildIdentity } from "../src/supervisor/identity.ts"
import { runCommand } from "../src/supervisor/workspaces.ts"

const LIVE = process.env.OCD_LIVE_EGRESS === "1"
const DOCKER = path.join(import.meta.dir, "..", "docker")
const REPO_ROOT = path.join(import.meta.dir, "..", "..", "..")
const PROJECT = `ocd-front-live-${randomBytes(3).toString("hex")}`
const IMAGE = `${PROJECT}:test`
const T = 10 * 60_000
const BUILD_T = 30 * 60_000

type Reply = { status?: number; body?: string; error?: string; message?: string }
type V6 = { lookup: string[]; aaaa: string[] }
type KsReply = { status?: number; front?: boolean; error?: string }
type Probe = {
  frontIp: string
  dns: Record<string, string[]>
  discovery: Reply
  discoveryPublicCaOnly: Reply
  synapseNoKey: Reply
  sniSwap: Reply
  sniSwapVault: Reply
  hostSwap: Reply
  hostSwapAllowed: Reply
  hostSwapAbsoluteUri: string
  noSni: string
  directPublicIp: string
  connectOverTls: string
  connectPlain: string
  oldProxyPorts: Record<string, string>
  gateway: { ip: string; ports: Record<string, string> }
  ipv6: { addresses: string[]; direct: string; names: Record<string, V6> }
  keystonePaths: Record<string, KsReply>
}
type BunFetch = { ok: boolean; status?: number; issuer?: string | null; error?: string }

const probes: Record<string, Probe> = {}
const bun: Record<string, { with: BunFetch; without: BunFetch }> = {}
let boxImage = ""
let boxTitle = ""
let gateway = ""
let scratch = ""
/** front's servers for the default Keystone set (rag-global, github, seqlogs), as the bridge writes them. */
const SERVERS = frontServersFor(defaultConfig({}))

// compose.yaml needs its interpolation variables even for the services this test does not start.
const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  OCD_IMAGE: IMAGE,
  OCD_CONTAINER: PROJECT,
  OCD_PROFILE_HASH: "live",
  OCD_PORT: "0",
  OCD_INBOX_PORT: "0",
  OCD_HANDOFF_DIR: scratch,
  OCD_PROFILE_DIR: scratch,
  OCD_FRONT_DIR: path.join(scratch, "front"),
  OCD_FRONT_HASH: frontConfigHash(SERVERS),
  OCD_LIVE_BOX_IMAGE: boxImage || "unset",
  ...extra,
})
const composeArgs = (...args: string[]) => ["docker", "compose", "-p", PROJECT, "-f", path.join(DOCKER, "compose.yaml"), "-f", path.join(DOCKER, "front", "live", "probe.yaml"), ...args]
const compose = (...args: string[]) => runCommand(composeArgs(...args), env(), T)
const docker = (...args: string[]) => runCommand(["docker", ...args], process.env, 120_000)
const exec = (container: string, ...argv: string[]) => docker("exec", container, ...argv)

async function json<T>(container: string, ...argv: string[]): Promise<T> {
  const run = await exec(container, ...argv)
  if (run.code !== 0) throw new Error(`${container} failed: ${run.stderr.slice(-800)}`)
  return JSON.parse(run.stdout.trim()) as T
}

/** The box image the bridge runs for this checkout, built (as the bridge would) when missing. */
async function realBoxImage(): Promise<string> {
  if (process.env.OCD_LIVE_BOX_IMAGE) return process.env.OCD_LIVE_BOX_IMAGE
  const identity = await buildIdentity(REPO_ROOT, defaultConfig({}).image, (argv, o) => runCommand(argv, process.env, o?.timeoutMs))
  if ((await docker("image", "inspect", "--format", "{{.Id}}", identity.image)).code === 0) return identity.image
  const build = await runCommand(composeArgs("build", "box"), env({ OCD_IMAGE: identity.image, OCD_OPENCODE_VERSION: identity.opencodeVersion }), BUILD_T)
  if (build.code !== 0) throw new Error(`box image build failed: ${build.stderr.slice(-800)}`)
  return identity.image
}

/** `sealed`'s IPv4 gateway: the Docker host's address on it (Docker gives the bridge the first host address). */
async function sealedGateway(): Promise<string> {
  const run = await docker("network", "inspect", "--format", "{{json .IPAM.Config}}", `${PROJECT}_sealed`)
  const config = JSON.parse(run.stdout.trim() || "[]") as Array<{ Subnet?: string; Gateway?: string }>
  const v4 = config.find((entry) => entry.Subnet?.includes("."))
  if (v4?.Gateway) return v4.Gateway
  const base = v4?.Subnet?.split("/")[0]?.split(".") ?? []
  return base.length === 4 ? [...base.slice(0, 3), String(Number(base[3]) + 1)].join(".") : ""
}

/** Nothing of the throwaway project is left: containers, volumes, networks. */
async function leftovers(): Promise<string[]> {
  const label = `label=com.docker.compose.project=${PROJECT}`
  const lists = await Promise.all([docker("ps", "-aq", "--filter", label), docker("volume", "ls", "-q", "--filter", label), docker("network", "ls", "-q", "--filter", label)])
  return lists.flatMap((run, i) => run.stdout.split("\n").filter(Boolean).map((id) => `${["container", "volume", "network"][i]} ${id}`))
}

const PROBES = [
  ["node:22-slim", "probe"],
  ["box image", "probe-box"],
] as const

describe.skipIf(!LIVE)("front live red/green (throwaway project)", () => {
  beforeAll(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), "ocd-front-live-"))
    await mkdir(path.join(scratch, "front"))
    await writeFile(path.join(scratch, "front", "servers.conf"), SERVERS)
    boxImage = await realBoxImage()
    const up = await compose("up", "-d", "--build", "front", "probe", "probe-bun", "probe-box")
    if (up.code !== 0) throw new Error(`compose up failed: ${up.stderr.slice(-800)}`)
    gateway = await sealedGateway()
    boxTitle = (await docker("image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.title"}}', boxImage)).stdout.trim()
    // NODE_EXTRA_CA_CERTS is unset for client.mjs: it passes front's CA itself where it wants it, and
    // its "public roots only" probe must not also trust front's CA (the box's env adds it; bun-fetch
    // below covers the env variable itself).
    for (const [label, service] of PROBES) {
      probes[label] = await json<Probe>(`${PROJECT}-${service}-1`, "env", "-u", "NODE_EXTRA_CA_CERTS", "node", "/check/client.mjs", gateway)
      console.log(JSON.stringify({ label, image: label === "box image" ? boxImage : service, gateway: probes[label]!.gateway, ipv6: probes[label]!.ipv6 }))
    }
    for (const [label, service] of [["oven/bun", "probe-bun"], ["box image", "probe-box"]] as const) {
      const container = `${PROJECT}-${service}-1`
      bun[label] = { with: await json<BunFetch>(container, "bun", "/check/bun-fetch.mjs"), without: await json<BunFetch>(container, "env", "-u", "NODE_EXTRA_CA_CERTS", "bun", "/check/bun-fetch.mjs") }
    }
  }, BUILD_T + T)

  afterAll(async () => {
    await compose("down", "-v", "--remove-orphans")
    await docker("image", "rm", `${IMAGE}-front`)
    if (scratch) await rm(scratch, { recursive: true, force: true })
    const left = await leftovers()
    if (left.length) throw new Error(`throwaway project ${PROJECT} left ${left.join(", ")}`)
  }, T)

  test("the box probe ran the bridge's box image, and the gateway address was found", () => {
    expect(boxImage).toStartWith(process.env.OCD_LIVE_BOX_IMAGE ?? `${defaultConfig({}).image}:`)
    expect(boxTitle).toBe("opencode-delegate-box")
    expect(gateway).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  })

  for (const [label] of PROBES) {
    const p = () => probes[label]!

    test(`(a) ${label} green: an allowed host answers through front with the internal CA, and only with it`, () => {
      expect(p().discovery.status).toBe(200)
      expect(p().discovery.body).toStartWith('{"issuer":"https://identity.alterspective.com.au"')
      // The OAuth paths front allows are still the ones Keystone's discovery names (R4-01 drift check).
      for (const { path: allowed } of KEYSTONE_OAUTH_PATHS.filter((o) => o.path.startsWith("/api/")))
        expect(p().discovery.body).toContain(`"https://identity.alterspective.com.au${allowed}"`)
      // Public roots alone do not verify: front, not the real host, ended the box's TLS.
      expect(p().discoveryPublicCaOnly.error).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE")
      // The model gateway is reachable too (no key sent: 401).
      expect(p().synapseNoKey.status).toBe(401)
    })

    test(`(b) ${label} red: an SNI swap fails the handshake (no Cloudflare trace, no vault-mcp)`, () => {
      for (const reply of [p().sniSwap, p().sniSwapVault]) {
        expect(reply.status).toBeUndefined()
        expect(reply.message).toContain("unrecognized name")
      }
    })

    test(`(c) ${label} red: a Host swap gets 421 and never the other site's answer`, () => {
      for (const reply of [p().hostSwap, p().hostSwapAllowed]) {
        expect(reply.status).toBe(421)
        expect(reply.body).toContain("421 Misdirected Request")
        expect(reply.body).not.toMatch(/mcp|status|healthy/i)
      }
      expect(p().hostSwapAbsoluteUri).toBe("HTTP/1.1 421 Misdirected Request")
    })

    test(`(d) ${label} red: other names do not resolve, no SNI is refused, no direct route to a public IP`, () => {
      expect(p().dns.identity).toEqual([p().frontIp])
      expect(p().dns.synapse).toEqual([p().frontIp])
      for (const name of ["cloudflare", "vaultMcp", "random", "egress"]) expect({ name, found: p().dns[name] }).toEqual({ name, found: [] })
      expect(p().noSni).toContain("unrecognized name")
      expect(p().directPublicIp).toMatch(/^error: (ENETUNREACH|EHOSTUNREACH|ECONNREFUSED)|^timeout$/)
    })

    test(`(e) ${label} red: nothing speaks CONNECT, and the old proxy ports are closed`, () => {
      expect(p().connectOverTls).toMatch(/^HTTP\/1\.1 4\d\d /)
      expect(p().connectPlain).toMatch(/^HTTP\/1\.1 4\d\d /)
      for (const [port, reply] of Object.entries(p().oldProxyPorts)) expect({ port, reply }).toEqual({ port, reply: expect.stringMatching(/^error: ECONNREFUSED/) })
    })

    test(`(f) ${label} red: nothing on the sealed gateway (the Docker host side) accepts a connection`, () => {
      expect(p().gateway.ip).toBe(gateway)
      expect(Object.keys(p().gateway.ports).sort()).toEqual(["22", "2375", "2376", "443", "53", "80"])
      for (const [port, reply] of Object.entries(p().gateway.ports))
        expect({ port, reply }).toEqual({ port, reply: expect.stringMatching(/^error: (ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)|^timeout$/) })
    })

    test(`(h) ${label}: on Keystone only the chosen connections' paths pass front; tricks get 403 from front (R4-01)`, () => {
      const ks = p().keystonePaths
      // Front's own error page (never forwarded), versus an answer that came from Keystone.
      const refusedByFront = (reply: KsReply | undefined) => reply?.front === true && (reply.status === 403 || reply.status === 400)
      const fromKeystone = (reply: KsReply | undefined) => reply?.front === false && reply.status !== undefined
      expect({ discovery: ks.discovery?.status, metadata: ks.resourceMetadata?.status, mcp: ks.mcpNoAuth?.status }).toEqual({ discovery: 200, metadata: 200, mcp: 401 })
      for (const name of ["discovery", "resourceMetadata", "mcpNoAuth", "encodedAllowed", "dotsIntoAllowed"]) expect({ name, ok: fromKeystone(ks[name]) }).toEqual({ name, ok: true })
      // Normalised into the allowed path: Keystone answers exactly as for the plain path.
      expect([ks.encodedAllowed?.status, ks.dotsIntoAllowed?.status]).toEqual([401, 401])
      const refused = Object.keys(ks).filter((name) => !["discovery", "resourceMetadata", "mcpNoAuth", "encodedAllowed", "dotsIntoAllowed"].includes(name))
      expect(refused.length).toBeGreaterThanOrEqual(19)
      for (const name of refused) expect({ name, reply: ks[name], front: refusedByFront(ks[name]) }).toEqual({ name, reply: ks[name]!, front: true })
    })

    test(`(g) ${label} red: no IPv6 address or route, and no AAAA answer that could go round front`, () => {
      expect(p().ipv6.addresses).toEqual([])
      expect(p().ipv6.direct).toMatch(/^error: (ENETUNREACH|EHOSTUNREACH|EADDRNOTAVAIL|ECONNREFUSED)|^timeout$/)
      for (const [name, v6] of Object.entries(p().ipv6.names)) {
        // A v4-mapped answer still leads to front's own IPv4 address; anything else would bypass it.
        const viaFront = (address: string) => address === `::ffff:${p().frontIp}`
        expect({ name, aaaa: v6.aaaa, other: v6.lookup.filter((a) => !viaFront(a)) }).toEqual({ name, aaaa: [], other: [] })
      }
    })
  }

  test("Bun (OpenCode's runtime) trusts front's CA through NODE_EXTRA_CA_CERTS, and fails without it, in oven/bun and the box image", () => {
    for (const [label, runs] of Object.entries(bun)) {
      expect({ label, ...runs.with }).toMatchObject({ label, ok: true, status: 200, issuer: "https://identity.alterspective.com.au" })
      expect({ label, ...runs.without }).toMatchObject({ label, ok: false, error: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })
    }
    expect(Object.keys(bun).sort()).toEqual(["box image", "oven/bun"])
  })
})
