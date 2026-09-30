// Live proof for reviews C-5 (plain HTTP) and C-6 (DNS). Needs Docker and internet, so it runs only
// with OCD_LIVE_EGRESS=1. It uses its own throwaway compose project and always runs `down -v`.
//   OCD_LIVE_EGRESS=1 bun test test/egress-live.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { runCommand } from "../src/supervisor/workspaces.ts"

const LIVE = process.env.OCD_LIVE_EGRESS === "1"
const COMPOSE = path.join(import.meta.dir, "..", "docker", "egress", "live", "compose.yaml")
const PROJECT = `ocd-egress-live-${randomBytes(3).toString("hex")}`
const T = 10 * 60_000

type Probe = Record<string, string | boolean>
let probe: Probe = {}

const compose = (...args: string[]) => runCommand(["docker", "compose", "-p", PROJECT, "-f", COMPOSE, ...args], process.env, T)

describe.skipIf(!LIVE)("egress live check (throwaway project)", () => {
  beforeAll(async () => {
    const up = await compose("up", "-d", "--build")
    if (up.code !== 0) throw new Error(`compose up failed: ${up.stderr.slice(-800)}`)
    const run = await runCommand(["docker", "exec", `${PROJECT}-client-1`, "node", "/check/client.mjs"], process.env, 120_000)
    if (run.code !== 0) throw new Error(`client failed: ${run.stderr.slice(-800)}`)
    probe = JSON.parse(run.stdout.trim()) as Probe
  }, T)

  afterAll(async () => {
    await compose("down", "-v", "--remove-orphans")
  }, T)

  test("CONNECT to an allowed host on 443 is tunnelled", () => {
    expect(String(probe.connectAllowed)).toMatch(/^HTTP\/1\.[01] 200/)
  })

  test("CONNECT to anything else is refused", () => {
    expect(String(probe.connectDenied)).toMatch(/^HTTP\/1\.[01] 403/)
    expect(String(probe.connectAllowedPort80)).toMatch(/^HTTP\/1\.[01] 403/)
    expect(String(probe.connectTrailingDot)).toMatch(/^HTTP\/1\.[01] 403/)
  })

  test("plain HTTP is refused, to allowed and non-allowed hosts alike (C-5)", () => {
    for (const key of ["plainAllowed", "plainDenied", "plainAllowedPort443", "plainNoScheme", "plainOriginForm"]) {
      expect({ key, line: String(probe[key]) }).toEqual({ key, line: expect.stringMatching(/^HTTP\/1\.[01] 403/) })
    }
  })

  test("the sealed network resolves no external name and has no direct route (C-6)", () => {
    expect(probe.dnsRandom).toBe(false)
    expect(probe.dnsExample).toBe(false)
    expect(probe.dnsAllowed).toBe(false)
    expect(probe.directToPublicIp).toBe(false)
    // Positive control: in-project service names still resolve.
    expect(probe.dnsEgress).toBe(true)
  })
})
