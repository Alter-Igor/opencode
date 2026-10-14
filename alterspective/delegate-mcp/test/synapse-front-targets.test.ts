// #178: two box generations (#171/#172) share one token state but each has its own front folder.
// A renewal by any bridge must reach every box's include and reload every front, or the box whose
// bridge did not renew keeps an expired bearer and Synapse answers 401.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createKsPublisher } from "../src/keystone-auth/host-wiring.ts"
import { frontDir } from "../src/shared/config.ts"
import { silentLogger } from "../src/shared/log.ts"
import type { Exec } from "../src/supervisor/docker.ts"
import { rememberGeneration } from "../src/supervisor/generations.ts"
import { authConfHasToken, authConfPath, ksAuthConfPath } from "../src/synapse/auth-conf.ts"
import { frontTargets, type FrontTarget } from "../src/synapse/front-targets.ts"
import { memoryStore } from "../src/synapse/secret-store.ts"
import { FRONT_RELOAD, adopt, failClosed, readState, type SynapseDeps } from "../src/synapse/token-manager.ts"
import { jwt } from "./synapse-fixture.ts"

const BASE = "ocd-test"
const GEN = "ocd-test-0123456789ab"
const ACCESS = jwt({ sub: "oid-1", email: "owner@example.test", act: { sub: "service:opencode" } })

/** A home with the base box's and one generation's front folders, as a running pair leaves them. */
async function twoBoxes() {
  const home = mkdtempSync(path.join(os.tmpdir(), "ocd-targets-"))
  await rememberGeneration(home, GEN)
  const base: FrontTarget = { frontDir: frontDir({ home, project: BASE }), frontContainer: `${BASE}-front` }
  const gen: FrontTarget = { frontDir: frontDir({ home, project: GEN }), frontContainer: `${GEN}-front` }
  mkdirSync(base.frontDir, { recursive: true })
  mkdirSync(gen.frontDir, { recursive: true })
  return { home, base, gen }
}

function deps(home: string, own: FrontTarget, reloaded: string[]): SynapseDeps {
  const exec: Exec = async (argv) => {
    if (argv.includes(FRONT_RELOAD)) reloaded.push(argv[2] ?? "")
    return { code: 0, stdout: "true\n", stderr: "" }
  }
  return {
    home,
    frontDir: own.frontDir,
    frontContainer: own.frontContainer,
    targets: () => frontTargets(home, BASE, own),
    origin: "https://identity.alterspective.com.au",
    store: memoryStore("rt-1"),
    memory: { id: "bridge-a" },
    secrets: async () => ({ brokerKey: "bk", clientSecret: "cs" }),
    fetch: async () => new Response("{}", { status: 500 }),
    exec,
    lock: (fn) => fn(),
    now: () => 1_000_000,
    refreshFraction: 0.8,
    opener: () => {},
    log: silentLogger,
  }
}

const hasToken = (dir: string) => authConfHasToken(readFileSync(authConfPath(dir), "utf8"))

describe("frontTargets", () => {
  test("own first, then the base box and each remembered generation whose folder exists, each once", async () => {
    const { home, base, gen } = await twoBoxes()
    expect(await frontTargets(home, BASE, gen)).toEqual([gen, base])
    expect(await frontTargets(home, BASE, base)).toEqual([base, gen])
  })

  test("a remembered generation whose folder was never made is left out (nothing is created there)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ocd-targets-"))
    await rememberGeneration(home, GEN)
    const base: FrontTarget = { frontDir: frontDir({ home, project: BASE }), frontContainer: `${BASE}-front` }
    expect(await frontTargets(home, BASE, base)).toEqual([base])
  })
})

describe("a Synapse renewal reaches every box", () => {
  test("the bridge bound to the generation renews: the base box's include and front get it too", async () => {
    const { home, base, gen } = await twoBoxes()
    // The base box still holds an old (expired) token: the state of 2026-10-14.
    writeFileSync(authConfPath(base.frontDir), "stale")
    const reloaded: string[] = []
    expect(await adopt(deps(home, gen, reloaded), { accessToken: ACCESS, expiresInSec: 1000 })).toBe("reloaded")
    expect(hasToken(gen.frontDir)).toBe(true)
    expect(hasToken(base.frontDir)).toBe(true)
    expect(reloaded).toEqual([gen.frontContainer, base.frontContainer])
    // Only this bridge's own front is recorded in the state oc_doctor reads.
    expect((await readState(home))?.lastReload?.result).toBe("reloaded")
  })

  test("failing closed empties every box's include", async () => {
    const { home, base, gen } = await twoBoxes()
    const reloaded: string[] = []
    const d = deps(home, base, reloaded)
    await adopt(d, { accessToken: ACCESS, expiresInSec: 1000 })
    await failClosed(d, "refused")
    expect(hasToken(base.frontDir)).toBe(false)
    expect(hasToken(gen.frontDir)).toBe(false)
  })

  test("without targets only this bridge's front is written (the earlier behaviour)", async () => {
    const { home, base, gen } = await twoBoxes()
    const reloaded: string[] = []
    const { targets: _unused, ...rest } = deps(home, base, reloaded)
    await adopt(rest, { accessToken: ACCESS, expiresInSec: 1000 })
    expect(hasToken(base.frontDir)).toBe(true)
    expect(() => readFileSync(authConfPath(gen.frontDir))).toThrow()
    expect(reloaded).toEqual([base.frontContainer])
  })
})

describe("a Keystone publish reaches every box", () => {
  test("the include goes to the bound box and every other; another box's write failure is not thrown", async () => {
    const { base, gen } = await twoBoxes()
    const publish = createKsPublisher({ frontDir: gen.frontDir, otherFrontDirs: async () => [gen.frontDir, base.frontDir, path.join(base.frontDir, "missing", "\0bad")], reload: async () => "reloaded", connect: async () => {}, log: silentLogger })
    await publish("rag-read", ACCESS)
    for (const dir of [gen.frontDir, base.frontDir]) expect(readFileSync(ksAuthConfPath(dir, "rag-read"), "utf8")).toContain(`"Bearer ${ACCESS}"`)
  })
})
