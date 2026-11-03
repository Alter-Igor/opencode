// #178: two box generations (#171/#172) share one token state but each has its own front folder.
// A renewal by any bridge must reach every box's include and reload every front, or the box whose
// bridge did not renew keeps an expired bearer and Synapse answers 401.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { FRONT_SERVERS_NAME } from "../src/guard/egress.ts"
import { createKsPublisher } from "../src/keystone-auth/host-wiring.ts"
import { frontDir } from "../src/shared/config.ts"
import { silentLogger, type Level, type Logger } from "../src/shared/log.ts"
import type { Exec } from "../src/supervisor/docker.ts"
import { rememberGeneration } from "../src/supervisor/generations.ts"
import { authConf, authConfHasToken, authConfPath, emptyUnchosenKsAuthConf, ksAuthConfPath, writeKsAuthConf } from "../src/synapse/auth-conf.ts"
import { createSynapseAuth, synapseReport } from "../src/synapse/index.ts"
import { refreshIfDue, reloadRetryDue } from "../src/synapse/refresh.ts"
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

function deps(home: string, own: FrontTarget, reloaded: string[], failing?: string): SynapseDeps {
  const exec: Exec = async (argv) => {
    if (argv.includes(FRONT_RELOAD)) {
      reloaded.push(argv[2] ?? "")
      // front-reload exit 4 (nginx -t refused) for one container only.
      if (argv[2] === failing) return { code: 4, stdout: "", stderr: "front-reload: refused" }
    }
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

  test("another box's failed reload neither changes nor records this bridge's result", async () => {
    const { home, base, gen } = await twoBoxes()
    const reloaded: string[] = []
    expect(await adopt(deps(home, base, reloaded, gen.frontContainer), { accessToken: ACCESS, expiresInSec: 1000 })).toBe("reloaded")
    expect(reloaded).toEqual([base.frontContainer, gen.frontContainer])
    const last = (await readState(home))?.lastReload
    expect(last?.result).toBe("reloaded")
    expect(last?.failures).toBeUndefined()
  })

  test("past expiry, another box's include is emptied even when this box's is already empty", async () => {
    const { home, base, gen } = await twoBoxes()
    const reloaded: string[] = []
    let clock = 1_000_000
    // Keystone is down (the fake answers 500): a passing failure, so past expiry the token is removed.
    const d: SynapseDeps = { ...deps(home, base, reloaded), now: () => clock }
    await adopt(d, { accessToken: ACCESS, expiresInSec: 1000 })
    writeFileSync(authConfPath(base.frontDir), authConf(undefined))
    clock += 2_000_000
    expect((await refreshIfDue(d)).outcome).toBe("expired")
    expect(hasToken(gen.frontDir)).toBe(false)
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
  test("the include goes to the bound box and every other box that has it; another box's write failure is not thrown", async () => {
    const { base, gen } = await twoBoxes()
    // The base box chose rag-read (its empty include exists); a third folder did not.
    writeFileSync(ksAuthConfPath(base.frontDir, "rag-read"), "")
    const unchosen = mkdtempSync(path.join(os.tmpdir(), "ocd-unchosen-"))
    // A box that chose rag-read but whose write fails: logged, never thrown.
    const failing = mkdtempSync(path.join(os.tmpdir(), "ocd-failing-"))
    writeFileSync(ksAuthConfPath(failing, "rag-read"), "")
    const tried: string[] = []
    const write = async (dir: string, id: string, token: string | undefined) => {
      tried.push(dir)
      if (dir === failing) throw new Error("disk full")
      await writeKsAuthConf(dir, id, token)
    }
    const publish = createKsPublisher({ frontDir: gen.frontDir, otherFrontDirs: async () => [gen.frontDir, base.frontDir, unchosen, failing], reload: async () => "reloaded", connect: async () => {}, log: silentLogger, write })
    await publish("rag-read", ACCESS)
    expect(tried).toEqual([gen.frontDir, base.frontDir, failing])
    for (const dir of [gen.frontDir, base.frontDir]) expect(readFileSync(ksAuthConfPath(dir, "rag-read"), "utf8")).toContain(`"Bearer ${ACCESS}"`)
    // #67 L4: no bearer on disk for a connection that box did not choose.
    expect(() => readFileSync(ksAuthConfPath(unchosen, "rag-read"))).toThrow()
  })

  test("#180 item 6: an emptied unchosen ks-auth-<id>.conf is skipped when servers.conf does not include it, and unlink option removes it", async () => {
    const { base, gen } = await twoBoxes()
    writeFileSync(ksAuthConfPath(base.frontDir, "m365"), authConf(ACCESS))
    writeFileSync(path.join(base.frontDir, FRONT_SERVERS_NAME), "# servers.conf without m365\ninclude /etc/nginx/front-gen/ks-auth-rag-read.conf;\n")
    await emptyUnchosenKsAuthConf(base.frontDir, ["rag-read"])
    const tried: string[] = []
    const publish = createKsPublisher({
      frontDir: gen.frontDir,
      otherFrontDirs: async () => [base.frontDir],
      reload: async () => "reloaded",
      connect: async () => {},
      log: silentLogger,
      write: async (dir, id, token) => {
        tried.push(dir)
        await writeKsAuthConf(dir, id, token)
      },
    })
    await publish("m365", ACCESS)
    expect(tried).toEqual([gen.frontDir])
    expect(await emptyUnchosenKsAuthConf(base.frontDir, ["rag-read"], { unlink: true })).toEqual(["m365"])
    expect(() => readFileSync(ksAuthConfPath(base.frontDir, "m365"))).toThrow()
  })
})

describe("#206 and #180 follow-ups", () => {
  test("#206: createSynapseAuth captures baseProject before config.project is mutated to a generation", async () => {
    const { home, base, gen } = await twoBoxes()
    const config = { home, keystoneOrigin: "https://identity.alterspective.com.au", project: BASE }
    const auth = createSynapseAuth(config, {}, silentLogger)
    // Simulate place() mutating config.project and rebinding Synapse deps to the generation.
    config.project = GEN
    auth.deps.frontDir = gen.frontDir
    auth.deps.frontContainer = gen.frontContainer
    expect(await auth.deps.targets?.()).toEqual([gen, base])
    expect(await frontTargets(home, BASE, gen.frontDir, gen.frontContainer)).toEqual([gen, base])
  })

  test("#180 item 4: reloadFronts skips stopped secondary front containers without running front-reload or logging a warning", async () => {
    const { home, base, gen } = await twoBoxes()
    const reloaded: string[] = []
    const warnings: string[] = []
    const log: Logger = {
      log: (level: Level, _c: string, msg: string) => {
        if (level === "warn") warnings.push(msg)
      },
    }
    const exec: Exec = async (argv) => {
      if (argv.includes("inspect")) {
        const name = argv.at(-1)
        return { code: 0, stdout: name === gen.frontContainer ? "false\n" : "true\n", stderr: "" }
      }
      if (argv.includes(FRONT_RELOAD)) reloaded.push(argv[2] ?? "")
      return { code: 0, stdout: "", stderr: "" }
    }
    const d: SynapseDeps = { ...deps(home, base, reloaded), exec, log }
    expect(await adopt(d, { accessToken: ACCESS, expiresInSec: 1000 })).toBe("reloaded")
    expect(reloaded).toEqual([base.frontContainer])
    expect(warnings).toEqual([])
    expect((await readState(home))?.lastReloadFailedContainers).toBeUndefined()
  })

  test("#180 item 2: transient reload failure on a running secondary front is recorded and retried by reloadRetryDue", async () => {
    const { home, base, gen } = await twoBoxes()
    const reloaded: string[] = []
    let failGen = true
    let clock = 1_000_000
    const exec: Exec = async (argv) => {
      if (argv.includes("inspect")) return { code: 0, stdout: "true\n", stderr: "" }
      if (argv.includes(FRONT_RELOAD)) {
        reloaded.push(argv[2] ?? "")
        if (argv[2] === gen.frontContainer && failGen) return { code: 5, stdout: "", stderr: "front-reload: busy" }
      }
      return { code: 0, stdout: "", stderr: "" }
    }
    const d: SynapseDeps = { ...deps(home, base, reloaded), exec, now: () => clock }
    await adopt(d, { accessToken: ACCESS, expiresInSec: 1000 })
    const afterFail = await readState(home)
    expect(afterFail?.lastReloadFailedContainers?.[gen.frontContainer]).toMatchObject({ at: clock, failures: 1 })
    expect(reloadRetryDue(afterFail!, clock + 10_000)).toBe(false)
    expect(reloadRetryDue(afterFail!, clock + 31_000)).toBe(true)

    failGen = false
    clock += 31_000
    reloaded.length = 0
    expect(await refreshIfDue(d)).toEqual({ outcome: "fresh", reload: "reloaded" })
    expect(reloaded).toEqual([base.frontContainer, gen.frontContainer])
    expect((await readState(home))?.lastReloadFailedContainers).toBeUndefined()
  })

  test("#180 item 1 & #187: synapseReport checks other running fronts and sets ok:false when a secondary running front is empty", async () => {
    const { home, base, gen } = await twoBoxes()
    const reloaded: string[] = []
    const d = deps(home, base, reloaded)
    await adopt(d, { accessToken: ACCESS, expiresInSec: 1000 })
    const servers = [
      "server {",
      "    server_name synapse2-api.alterspective.com.au;",
      "    location / {",
      "    }",
      "    location = /v1/chat/completions {",
      "    }",
      "    location = /v1/models {",
      "    }",
      "}",
    ].join("\n")
    const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
    const makeExec = (genAuthOverride?: string): Exec => async (argv) => {
      if (argv.includes("inspect")) return { code: 0, stdout: "true\n", stderr: "" }
      const container = argv[2] ?? ""
      const auth = container === gen.frontContainer && genAuthOverride !== undefined
        ? genAuthOverride
        : readFileSync(authConfPath(container === gen.frontContainer ? gen.frontDir : base.frontDir), "utf8")
      if (argv.includes("wget")) return { code: 0, stdout: `${"a".repeat(32)} ${sha256(servers)} ${sha256(auth)}\n`, stderr: "" }
      if (argv.includes("cat")) {
        const file = argv.at(-1) ?? ""
        if (file.endsWith("/source-servers.conf")) return { code: 0, stdout: servers, stderr: "" }
        if (file.endsWith("/synapse-auth.conf")) return { code: 0, stdout: auth, stderr: "" }
      }
      return { code: 0, stdout: "", stderr: "" }
    }
    const okReport = await synapseReport(d, makeExec())
    expect(okReport.ok).toBe(true)
    expect(okReport.otherFronts).toEqual([
      {
        container: gen.frontContainer,
        hostFile: { shapeOk: true, hasToken: true },
        loadedSinceWrite: true,
        live: { shapeOk: true, hasToken: true, matchesHost: true, routesOk: true },
        ok: true,
      },
    ])

    // Now make the secondary running front serve an empty include while the token is valid.
    const badReport = await synapseReport(d, makeExec(authConf(undefined)))
    expect(badReport.ok).toBe(false)
    expect(badReport.otherFronts?.[0]?.ok).toBe(false)
    expect(badReport.otherFronts?.[0]?.live).toMatchObject({ hasToken: false, matchesHost: false })
  })
})

