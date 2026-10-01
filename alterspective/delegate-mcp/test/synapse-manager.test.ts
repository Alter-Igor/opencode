// WS2 (#48): renewal timing, one refresh at a time across bridges (the real start-lock on a temp
// home), fail-closed paths, and the refresh-token store. Keystone and docker are fakes.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { silentLogger } from "../src/shared/log.ts"
import type { Exec } from "../src/supervisor/docker.ts"
import { nodeLeaseFs } from "../src/supervisor/leases.ts"
import { nodeProcessProbe } from "../src/supervisor/process.ts"
import { withStartLock } from "../src/supervisor/start-lock.ts"
import { authConfHasToken, authConfPath, isAuthConf } from "../src/synapse/auth-conf.ts"
import { refreshFraction } from "../src/synapse/index.ts"
import { dpapiStore, memoryStore, type PowerShell } from "../src/synapse/secret-store.ts"
import { adopt, isDue, readState, refreshAt, refreshIfDue, type SynapseDeps } from "../src/synapse/token-manager.ts"
import type { Fetch } from "../src/synapse/keystone-token.ts"
import { jwt } from "./synapse-fixture.ts"

const ACCESS = jwt({ sub: "oid-1", email: "owner@example.test", act: { sub: "service:opencode" } })

function harness(over: Partial<SynapseDeps> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ocd-synapse-"))
  const calls = { fetch: 0, exec: [] as string[][] }
  let clock = 1_000_000
  const exec: Exec = async (argv) => {
    calls.exec.push(argv)
    return { code: 0, stdout: "", stderr: "" }
  }
  const fetcher: Fetch = async () => {
    calls.fetch++
    await new Promise((r) => setTimeout(r, 30))
    return new Response(JSON.stringify({ access_token: ACCESS, refresh_token: "rt-rotated", expires_in: 1000 }), { status: 200 })
  }
  const lockFile = path.join(home, "synapse", "refresh.lock")
  const deps: SynapseDeps = {
    home,
    frontDir: path.join(home, "front"),
    origin: "https://identity.alterspective.com.au",
    frontContainer: "ocd-test-front",
    store: memoryStore("rt-1"),
    secrets: async () => ({ brokerKey: "bk", clientSecret: "cs" }),
    fetch: fetcher,
    exec,
    lock: (fn) => withStartLock(nodeLeaseFs, lockFile, fn, { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), probe: nodeProcessProbe, self: { pid: process.pid, startedAt: 1 }, waitMs: 10_000 }),
    now: () => clock,
    refreshFraction: 0.8,
    opener: () => {},
    log: silentLogger,
    ...over,
  }
  return { deps, calls, home, advance: (ms: number) => (clock += ms), conf: () => readFileSync(authConfPath(deps.frontDir), "utf8") }
}

describe("refresh timing", () => {
  test("due at 80% of the lifetime, not before; a state that needs sign-in is never due", () => {
    const state = { obtainedAt: 0, expiresAt: 1000 }
    expect(refreshAt(state, 0.8)).toBe(800)
    expect(isDue(state, 799, 0.8)).toBe(false)
    expect(isDue(state, 800, 0.8)).toBe(true)
    expect(isDue({ ...state, needsSignIn: true }, 900, 0.8)).toBe(false)
    expect(isDue(undefined, 900, 0.8)).toBe(false)
  })

  test("the test env can shorten the threshold, within 0.01-0.95 only", () => {
    expect(refreshFraction({})).toBe(0.8)
    expect(refreshFraction({ OPENCODE_DELEGATE_SYNAPSE_REFRESH_FRACTION: "0.05" })).toBe(0.05)
    expect(refreshFraction({ OPENCODE_DELEGATE_SYNAPSE_REFRESH_FRACTION: "0" })).toBe(0.8)
    expect(refreshFraction({ OPENCODE_DELEGATE_SYNAPSE_REFRESH_FRACTION: "2" })).toBe(0.8)
  })
})

describe("refreshIfDue", () => {
  test("not due: no Keystone call", async () => {
    const h = harness()
    await adopt(h.deps, { accessToken: ACCESS, expiresInSec: 1000 })
    expect(await refreshIfDue(h.deps)).toEqual({ outcome: "fresh" })
    expect(h.calls.fetch).toBe(0)
  })

  test("due: refreshes, stores the rotated refresh token, writes front's include and reloads (test, then reload)", async () => {
    const h = harness()
    await adopt(h.deps, { accessToken: ACCESS, expiresInSec: 1000 })
    h.calls.exec.length = 0
    h.advance(800_000)
    const result = await refreshIfDue(h.deps)
    expect(result).toEqual({ outcome: "refreshed", reload: "reloaded" })
    expect((h.deps.store as ReturnType<typeof memoryStore>).value).toBe("rt-rotated")
    expect(authConfHasToken(h.conf())).toBe(true)
    expect(h.calls.exec).toEqual([
      ["docker", "exec", "ocd-test-front", "nginx", "-t", "-q"],
      ["docker", "exec", "ocd-test-front", "nginx", "-s", "reload"],
    ])
    const state = await readState(h.home)
    expect(state).toMatchObject({ user: "owner@example.test", actor: "service:opencode" })
    expect(JSON.stringify(state)).not.toContain(ACCESS)
  })

  test("single flight: two bridges due at once make ONE Keystone call (the second sees the new state under the lock)", async () => {
    const h = harness()
    await adopt(h.deps, { accessToken: ACCESS, expiresInSec: 1000 })
    h.advance(900_000)
    const other = { ...h.deps } // a second bridge on the same home: same files, its own deps object
    const [a, b] = await Promise.all([refreshIfDue(h.deps), refreshIfDue(other)])
    expect(h.calls.fetch).toBe(1)
    expect([a.outcome, b.outcome].sort()).toEqual(["fresh", "refreshed"])
  })

  test("no stored refresh token: fails closed (include emptied, state needs sign-in)", async () => {
    const h = harness({ store: memoryStore(undefined) })
    await adopt(h.deps, { accessToken: ACCESS, expiresInSec: 1000 })
    h.advance(900_000)
    const result = await refreshIfDue(h.deps)
    expect(result.outcome).toBe("failed_closed")
    expect(isAuthConf(h.conf())).toBe(true)
    expect(authConfHasToken(h.conf())).toBe(false)
    expect(await readState(h.home)).toMatchObject({ needsSignIn: true, lastError: "no stored refresh token" })
    expect(h.calls.fetch).toBe(0)
  })

  test("Keystone refuses the refresh (401): fails closed", async () => {
    const h = harness({ fetch: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }) })
    await adopt(h.deps, { accessToken: ACCESS, expiresInSec: 1000 })
    h.advance(900_000)
    expect((await refreshIfDue(h.deps)).outcome).toBe("failed_closed")
    expect(authConfHasToken(h.conf())).toBe(false)
  })

  test("a passing outage keeps the token until it expires, then removes it", async () => {
    const h = harness({ fetch: async () => new Response("{}", { status: 503 }) })
    await adopt(h.deps, { accessToken: ACCESS, expiresInSec: 1000 })
    h.advance(900_000)
    expect((await refreshIfDue(h.deps)).outcome).toBe("fresh")
    expect(authConfHasToken(h.conf())).toBe(true)
    h.advance(200_000)
    expect((await refreshIfDue(h.deps)).outcome).toBe("failed_closed")
    expect(authConfHasToken(h.conf())).toBe(false)
  })
})

describe("refresh-token store", () => {
  test("memory store round trip", async () => {
    const store = memoryStore()
    expect(await store.has()).toBe(false)
    await store.write("rt")
    expect(await store.read()).toBe("rt")
    await store.remove()
    expect(await store.read()).toBeUndefined()
  })

  test("DPAPI store: the secret goes to PowerShell on stdin only; only the cipher is on disk", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocd-dpapi-"))
    const seen: Array<{ script: string; input: string }> = []
    const ps: PowerShell = async (script, input) => {
      seen.push({ script, input })
      return script.includes("::Protect(") ? Buffer.from(`enc:${input}`).toString("base64") : Buffer.from(input, "base64").toString("utf8").replace(/^enc:/, "")
    }
    const store = dpapiStore(path.join(dir, "refresh.dpapi"), ps, "win32")
    await store.write("rt-secret")
    expect(readFileSync(path.join(dir, "refresh.dpapi"), "utf8")).not.toContain("rt-secret")
    expect(seen.every((call) => !call.script.includes("rt-secret"))).toBe(true)
    expect(await store.read()).toBe("rt-secret")
    await store.remove()
    expect(await store.has()).toBe(false)
  })

  test("DPAPI store fails closed off Windows", async () => {
    const store = dpapiStore(path.join(os.tmpdir(), "nope.dpapi"), async () => "x", "linux")
    expect(store.write("rt")).rejects.toThrow("Windows DPAPI")
  })
})
