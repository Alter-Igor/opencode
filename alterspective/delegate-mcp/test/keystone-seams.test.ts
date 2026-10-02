// #67 combined review (seams), written before the fixes:
// L1 an access token front cannot carry (not a compact JWT, or > 3800 chars) is unusable, not a
//    publish failure retried forever; L2 a Keystone reload does not write Synapse state;
// L3 discovery runs outside the shared lock (cached) and a locked refresh that ran long defers
//    the publish; L4 a connection that left the chosen set has its front include emptied.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { refreshConnection, signIn, type KeystoneAuthDeps } from "../src/keystone-auth/manager.ts"
import { readTokenReply } from "../src/keystone-auth/oauth.ts"
import type { Level, Logger } from "../src/shared/log.ts"
import { authConf, emptyUnchosenKsAuthConf, KS_AUTH_VAR, ksAuthConfPath } from "../src/synapse/auth-conf.ts"
import { readState, reloadFront, writeState } from "../src/synapse/token-manager.ts"
import { cleanupHomes, harness, type Harness } from "./keystone-auth-fixture.ts"
import { deps, fakeDocker, home, supervisor, useSupervisorFixture, writeOwner, type Box, type Call } from "./supervisor-lifecycle-fixture.ts"

useSupervisorFixture()
afterEach(cleanupHomes)

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const jwtOf = (payloadPad: string) => `${b64({ alg: "RS256" })}.${b64({ sub: "o", pad: payloadPad })}.c2lnbmF0dXJlLXZhbHVl`
const TOKEN = jwtOf("marker")

function approving(d: KeystoneAuthDeps): KeystoneAuthDeps {
  return {
    ...d,
    opener: (url) => {
      const u = new URL(url)
      void fetch(`${u.searchParams.get("redirect_uri")}?code=test-code&state=${u.searchParams.get("state")}`).catch(() => undefined)
    },
  }
}

async function signedIn(h: Harness): Promise<void> {
  await signIn(approving(h.deps), "rag-read")
  h.published.length = 0
}

describe("L1: an access token front cannot carry", () => {
  test("too long or not a compact JWT is unusable, with a reason", () => {
    for (const access of [jwtOf("x".repeat(4000)), "opaque-token-value"]) {
      const reply = readTokenReply(JSON.stringify({ access_token: access, refresh_token: "r1", token_type: "Bearer", expires_in: 3600 }), Date.now())
      expect(reply.refreshToken).toBe("r1")
      expect("unusable" in reply.access && reply.access.unusable).toContain("compact JWT")
    }
  })

  test("a refresh that returns one saves the rotated refresh token and publishes nothing", async () => {
    const h = await harness()
    await signedIn(h)
    h.clock.now += 2_880_000
    h.keystone.reply = { access_token: "opaque-token-value" }
    const r = await refreshConnection(h.deps, "rag-read")
    expect(r.outcome).toBe("retrying")
    expect(r.error).toContain("compact JWT")
    expect(h.published).toHaveLength(0)
    expect(h.stores.get("rag-read")?.value).toBe(h.keystone.issued.at(-1))
  })
})

describe("L2: a Keystone reload of front", () => {
  test("does not touch Synapse state and logs under its own component; Synapse default unchanged", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocd-seams-"))
    await writeState(dir, { obtainedAt: 1, expiresAt: 2 })
    const lines: string[] = []
    const log: Logger = { log: (_l: Level, component: string, msg: string) => void lines.push(`${component}: ${msg}`) }
    const exec = async () => ({ code: 0, stdout: "", stderr: "" })
    expect(await reloadFront({ exec, frontContainer: "f", home: dir, now: () => 5, log }, { record: false, component: "keystone-auth" })).toBe("reloaded")
    expect((await readState(dir))?.lastReload).toBeUndefined()
    expect(lines).toEqual(["keystone-auth: front reloaded"])
    await reloadFront({ exec, frontContainer: "f", home: dir, now: () => 6, log })
    expect((await readState(dir))?.lastReload).toEqual({ result: "reloaded", at: 6 })
    expect(lines.at(-1)).toBe("synapse: front reloaded")
  })
})

describe("L3: the locked refresh", () => {
  test("discovery runs outside the lock and is cached", async () => {
    const h = await harness()
    await signedIn(h)
    let locked = false
    let discoveredLocked = 0
    const fetchFn: KeystoneAuthDeps["fetch"] = async (url, init) => {
      if (locked && String(url).includes("/.well-known/")) discoveredLocked++
      return h.keystone.fetch(url, init)
    }
    const d: KeystoneAuthDeps = { ...h.deps, fetch: fetchFn, lock: async (fn) => { locked = true; try { return await fn() } finally { locked = false } } }
    h.clock.now += 2_880_000
    expect((await refreshConnection(d, "rag-read")).outcome).toBe("refreshed")
    expect(discoveredLocked).toBe(0)
    const prm = h.keystone.calls.prm
    h.clock.now += 2_880_000
    expect((await refreshConnection(d, "rag-read")).outcome).toBe("refreshed")
    expect(h.keystone.calls.prm).toBe(prm)
  })

  test("a refresh whose token call ran long defers the publish to the next tick (no lock held past the deadline)", async () => {
    const h = await harness()
    await signedIn(h)
    const slow: KeystoneAuthDeps["fetch"] = async (url, init) => {
      const reply = await h.keystone.fetch(url, init)
      if (String(url).includes("token")) h.clock.now += 90_000
      return reply
    }
    h.clock.now += 2_880_000
    const r = await refreshConnection({ ...h.deps, fetch: slow }, "rag-read")
    expect(r.outcome).toBe("retrying")
    expect(r.error).toContain("deferred")
    expect(h.published).toHaveLength(0)
    expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("refreshed")
    expect(h.published).toHaveLength(1)
  })
})

describe("L4: a connection that left the chosen set", () => {
  test("emptyUnchosenKsAuthConf empties only unchosen includes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocd-seams-"))
    writeFileSync(ksAuthConfPath(dir, "m365"), authConf(TOKEN, KS_AUTH_VAR))
    writeFileSync(ksAuthConfPath(dir, "github"), authConf(TOKEN, KS_AUTH_VAR))
    expect(await emptyUnchosenKsAuthConf(dir, ["github"])).toEqual(["m365"])
    expect(readFileSync(ksAuthConfPath(dir, "m365"), "utf8")).toBe(authConf(undefined, KS_AUTH_VAR))
    expect(readFileSync(ksAuthConfPath(dir, "github"), "utf8")).toContain(TOKEN)
  })

  test("a flag-on start empties the include of a connection no longer chosen", async () => {
    await writeOwner()
    const front = path.join(home, "front")
    mkdirSync(front, { recursive: true })
    writeFileSync(ksAuthConfPath(front, "m365"), authConf(TOKEN, KS_AUTH_VAR))
    const before = process.env.OCD_KEYSTONE_HOST_AUTH
    process.env.OCD_KEYSTONE_HOST_AUTH = "1"
    try {
      const box: Box = { running: false, labels: {}, env: [] }
      const calls: Call[] = []
      await supervisor(deps(fakeDocker(box, calls))).ensure()
    } finally {
      if (before === undefined) delete process.env.OCD_KEYSTONE_HOST_AUTH
      else process.env.OCD_KEYSTONE_HOST_AUTH = before
    }
    expect(existsSync(ksAuthConfPath(front, "m365"))).toBe(true)
    expect(readFileSync(ksAuthConfPath(front, "m365"), "utf8")).not.toContain(TOKEN)
  })
})
