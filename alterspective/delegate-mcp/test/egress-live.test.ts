// Live red/green proof for review R3-01 (and C-6 DNS). Needs Docker and internet, so it runs only
// with OCD_LIVE_EGRESS=1. It starts the REAL `front` service from docker/compose.yaml plus two
// sealed probes (docker/front/live/probe.yaml) under a throwaway project, and always runs `down -v`.
// Only public, read-only GETs are sent; never credentials.
//   OCD_LIVE_EGRESS=1 bun test test/egress-live.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runCommand } from "../src/supervisor/workspaces.ts"

const LIVE = process.env.OCD_LIVE_EGRESS === "1"
const DOCKER = path.join(import.meta.dir, "..", "docker")
const PROJECT = `ocd-front-live-${randomBytes(3).toString("hex")}`
const IMAGE = `${PROJECT}:test`
const T = 10 * 60_000

type Reply = { status?: number; body?: string; error?: string; message?: string }
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
}
type BunFetch = { ok: boolean; status?: number; issuer?: string | null; error?: string }

let probe = {} as Probe
let bunWith = {} as BunFetch
let bunWithout = {} as BunFetch
let scratch = ""

// compose.yaml needs its interpolation variables even for the services this test does not start.
const env = () => ({
  ...process.env,
  OCD_IMAGE: IMAGE,
  OCD_CONTAINER: PROJECT,
  OCD_PROFILE_HASH: "live",
  OCD_PORT: "0",
  OCD_INBOX_PORT: "0",
  OCD_HANDOFF_DIR: scratch,
  OCD_PROFILE_DIR: scratch,
})
const compose = (...args: string[]) =>
  runCommand(["docker", "compose", "-p", PROJECT, "-f", path.join(DOCKER, "compose.yaml"), "-f", path.join(DOCKER, "front", "live", "probe.yaml"), ...args], env(), T)
const exec = (container: string, ...argv: string[]) => runCommand(["docker", "exec", container, ...argv], process.env, 120_000)

async function json<T>(container: string, ...argv: string[]): Promise<T> {
  const run = await exec(container, ...argv)
  if (run.code !== 0) throw new Error(`${container} failed: ${run.stderr.slice(-800)}`)
  return JSON.parse(run.stdout.trim()) as T
}

describe.skipIf(!LIVE)("front live red/green (throwaway project)", () => {
  beforeAll(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), "ocd-front-live-"))
    const up = await compose("up", "-d", "--build", "front", "probe", "probe-bun")
    if (up.code !== 0) throw new Error(`compose up failed: ${up.stderr.slice(-800)}`)
    probe = await json<Probe>(`${PROJECT}-probe-1`, "node", "/check/client.mjs")
    bunWith = await json<BunFetch>(`${PROJECT}-probe-bun-1`, "bun", "/check/bun-fetch.mjs")
    bunWithout = await json<BunFetch>(`${PROJECT}-probe-bun-1`, "env", "-u", "NODE_EXTRA_CA_CERTS", "bun", "/check/bun-fetch.mjs")
  }, T)

  afterAll(async () => {
    await compose("down", "-v", "--remove-orphans")
    await runCommand(["docker", "image", "rm", `${IMAGE}-front`], process.env, 120_000)
    if (scratch) await rm(scratch, { recursive: true, force: true })
  }, T)

  test("(a) green: an allowed host answers through front with the internal CA, and only with it", () => {
    expect(probe.discovery.status).toBe(200)
    expect(probe.discovery.body).toStartWith('{"issuer":"https://identity.alterspective.com.au"')
    // Public roots alone do not verify: front, not the real host, ended the box's TLS.
    expect(probe.discoveryPublicCaOnly.error).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE")
    // The model gateway is reachable too (no key sent: 401).
    expect(probe.synapseNoKey.status).toBe(401)
  })

  test("Bun (OpenCode's runtime) trusts front's CA through NODE_EXTRA_CA_CERTS, and fails without it", () => {
    expect(bunWith).toMatchObject({ ok: true, status: 200, issuer: "https://identity.alterspective.com.au" })
    expect(bunWithout).toMatchObject({ ok: false, error: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })
  })

  test("(b) red: an SNI swap fails the handshake (no Cloudflare trace, no vault-mcp)", () => {
    for (const reply of [probe.sniSwap, probe.sniSwapVault]) {
      expect(reply.status).toBeUndefined()
      expect(reply.message).toContain("unrecognized name")
    }
  })

  test("(c) red: a Host swap gets 421 and never the other site's answer", () => {
    for (const reply of [probe.hostSwap, probe.hostSwapAllowed]) {
      expect(reply.status).toBe(421)
      expect(reply.body).toContain("421 Misdirected Request")
      expect(reply.body).not.toMatch(/mcp|status|healthy/i)
    }
    expect(probe.hostSwapAbsoluteUri).toBe("HTTP/1.1 421 Misdirected Request")
  })

  test("(d) red: other names do not resolve, no SNI is refused, no direct route to a public IP", () => {
    expect(probe.dns.identity).toEqual([probe.frontIp])
    expect(probe.dns.synapse).toEqual([probe.frontIp])
    for (const name of ["cloudflare", "vaultMcp", "random", "egress"]) expect({ name, found: probe.dns[name] }).toEqual({ name, found: [] })
    expect(probe.noSni).toContain("unrecognized name")
    expect(probe.directPublicIp).toMatch(/^error: (ENETUNREACH|EHOSTUNREACH|ECONNREFUSED)|^timeout$/)
  })

  test("(e) red: nothing speaks CONNECT, and the old proxy ports are closed", () => {
    expect(probe.connectOverTls).toMatch(/^HTTP\/1\.1 4\d\d /)
    expect(probe.connectPlain).toMatch(/^HTTP\/1\.1 4\d\d /)
    for (const [port, reply] of Object.entries(probe.oldProxyPorts)) expect({ port, reply }).toEqual({ port, reply: expect.stringMatching(/^error: ECONNREFUSED/) })
  })
})
