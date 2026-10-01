// WS2 (#48): renewal timing, one refresh at a time across bridges (the real start-lock on a temp
// home), the two kinds of failure (review M2), a store that cannot save (M1), and the store itself.
// Keystone and docker are fakes.
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
import { RETRY_BASE_MS, backoffMs, refreshIfDue } from "../src/synapse/refresh.ts"
import { synapseReport } from "../src/synapse/report.ts"
import { dpapiStore, memoryStore, type PowerShell, type SecretStore } from "../src/synapse/secret-store.ts"
import { adopt, isDue, readState, refreshAt, type SynapseDeps } from "../src/synapse/token-manager.ts"
import type { Fetch } from "../src/synapse/keystone-token.ts"
import { jwt } from "./synapse-fixture.ts"

const ACCESS = jwt({ sub: "oid-1", email: "owner@example.test", act: { sub: "service:opencode" } })
const ok = (refresh = "rt-rotated") => new Response(JSON.stringify({ access_token: ACCESS, refresh_token: refresh, expires_in: 1000 }), { status: 200 })

function harness(over: Partial<SynapseDeps> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ocd-synapse-"))
  const calls = { fetch: 0, exec: [] as string[][] }
  let clock = 1_000_000
  let reply: () => Response = () => ok()
  const exec: Exec = async (argv) => {
    calls.exec.push(argv)
    return { code: argv.includes("-T") ? 1 : 0, stdout: "", stderr: "" }
  }
  const fetcher: Fetch = async () => {
    calls.fetch++
    await new Promise((r) => setTimeout(r, 30))
    return reply()
  }
  const lockFile = path.join(home, "synapse", "refresh.lock")
  const deps: SynapseDeps = {
    home,
    frontDir: path.join(home, "front"),
    origin: "https://identity.alterspective.com.au",
    frontContainer: "ocd-test-front",
    store: memoryStore("rt-1"),
    memory: {},
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
  const signedIn = () => deps.lock(() => adopt(deps, { accessToken: ACCESS, expiresInSec: 1000 }))
  return { deps, calls, home, signedIn, setReply: (fn: () => Response) => (reply = fn), advance: (ms: number) => (clock += ms), conf: () => readFileSync(authConfPath(deps.frontDir), "utf8") }
}

/** A store whose write and/or read fail until `heal()` (a DPAPI hiccup). */
function flakyStore(initial: string | undefined, fail: { write?: boolean; read?: boolean }): SecretStore & { heal(): void; value: string | undefined } {
  const inner = memoryStore(initial)
  let broken = true
  return {
    kind: "flaky",
    get value() { return inner.value },
    heal: () => void (broken = false),
    read: async () => { if (broken && fail.read) throw new Error("DPAPI read failed"); return inner.read() },
    write: async (value: string) => { if (broken && fail.write) throw new Error("DPAPI write failed"); return inner.write(value) },
    remove: () => inner.remove(),
    has: () => inner.has(),
  }
}

describe("refresh timing", () => {
  test("due at 80% of the lifetime, not before, not during backoff, not while waiting for a sign-in", () => {
    const state = { obtainedAt: 0, expiresAt: 1000 }
    expect(refreshAt(state, 0.8)).toBe(800)
    expect(isDue(state, 799, 0.8)).toBe(false)
    expect(isDue(state, 800, 0.8)).toBe(true)
    expect(isDue({ ...state, retryAt: 900 }, 850, 0.8)).toBe(false)
    expect(isDue({ ...state, needsSignIn: true }, 900, 0.8)).toBe(false)
    expect(isDue(undefined, 900, 0.8)).toBe(false)
  })

  test("backoff doubles from 30 s to at most 10 min; the test env shortens the threshold within 0.01-0.95", () => {
    expect([1, 2, 3, 10].map(backoffMs)).toEqual([RETRY_BASE_MS, 2 * RETRY_BASE_MS, 4 * RETRY_BASE_MS, 600_000])
    expect(refreshFraction({})).toBe(0.8)
    expect(refreshFraction({ OPENCODE_DELEGATE_SYNAPSE_REFRESH_FRACTION: "0.05" })).toBe(0.05)
    expect(refreshFraction({ OPENCODE_DELEGATE_SYNAPSE_REFRESH_FRACTION: "2" })).toBe(0.8)
  })
})

describe("refreshIfDue", () => {
  test("not due: no Keystone call", async () => {
    const h = harness()
    await h.signedIn()
    expect(await refreshIfDue(h.deps)).toEqual({ outcome: "fresh" })
    expect(h.calls.fetch).toBe(0)
  })

  test("due: refreshes, stores the rotated refresh token, writes front's include and reloads (test, then reload)", async () => {
    const h = harness()
    await h.signedIn()
    h.calls.exec.length = 0
    h.advance(800_000)
    expect(await refreshIfDue(h.deps)).toEqual({ outcome: "refreshed", reload: "reloaded" })
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

  test("single flight: two bridges due at once make ONE Keystone call", async () => {
    const h = harness()
    await h.signedIn()
    h.advance(900_000)
    const [a, b] = await Promise.all([refreshIfDue(h.deps), refreshIfDue({ ...h.deps })])
    expect(h.calls.fetch).toBe(1)
    expect([a.outcome, b.outcome].sort()).toEqual(["fresh", "refreshed"])
  })

  test("no stored refresh token: needs sign-in (include emptied)", async () => {
    const h = harness({ store: memoryStore(undefined) })
    await h.signedIn()
    h.advance(900_000)
    expect((await refreshIfDue(h.deps)).outcome).toBe("failed_closed")
    expect(isAuthConf(h.conf()) && !authConfHasToken(h.conf())).toBe(true)
    expect(await readState(h.home)).toMatchObject({ needsSignIn: true, lastError: "no stored refresh token" })
    expect(h.calls.fetch).toBe(0)
  })

  test("Keystone refuses the refresh (401 invalid_grant): needs sign-in", async () => {
    const h = harness()
    await h.signedIn()
    h.setReply(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }))
    h.advance(900_000)
    expect((await refreshIfDue(h.deps)).outcome).toBe("failed_closed")
    expect(authConfHasToken(h.conf())).toBe(false)
    expect((await synapseReport(h.deps, h.deps.exec)).state).toBe("needs_sign_in")
  })
})

describe("M2: a passing failure never signs the owner out", () => {
  test("an outage past expiry empties front but keeps retrying with backoff, and a later refresh restores it", async () => {
    const h = harness()
    await h.signedIn()
    h.setReply(() => new Response("{}", { status: 503 }))
    h.advance(900_000)
    expect((await refreshIfDue(h.deps)).outcome).toBe("retrying")
    expect(authConfHasToken(h.conf())).toBe(true) // not expired yet: the token stays
    expect(await refreshIfDue(h.deps)).toEqual({ outcome: "fresh" }) // inside the backoff: no call
    expect(h.calls.fetch).toBe(1)
    h.advance(200_000) // past expiry
    expect((await refreshIfDue(h.deps)).outcome).toBe("expired")
    expect(authConfHasToken(h.conf())).toBe(false)
    const state = await readState(h.home)
    expect(state?.needsSignIn).toBeUndefined()
    expect(state?.failures).toBe(2)
    expect((await synapseReport(h.deps, h.deps.exec)).state).toBe("expired")
    h.setReply(() => ok())
    h.advance(backoffMs(2))
    expect((await refreshIfDue(h.deps)).outcome).toBe("refreshed")
    expect(authConfHasToken(h.conf())).toBe(true)
    expect(await readState(h.home)).not.toHaveProperty("failures")
  })

  test("a store READ error is retried, not treated as a missing token", async () => {
    const store = flakyStore("rt-1", { read: true })
    const h = harness({ store })
    await h.signedIn()
    h.advance(900_000)
    const first = await refreshIfDue(h.deps)
    expect(first.outcome).toBe("retrying")
    expect(first.error).toContain("could not be read")
    expect((await readState(h.home))?.needsSignIn).toBeUndefined()
    store.heal()
    h.advance(backoffMs(1))
    expect((await refreshIfDue(h.deps)).outcome).toBe("refreshed")
  })
})

describe("M1: a store that cannot save never throws the new tokens away", () => {
  test("access token adopted, rotated refresh token kept in memory and used, then saved on a later tick", async () => {
    const store = flakyStore("rt-1", { write: true })
    const h = harness({ store })
    await h.signedIn()
    h.advance(900_000)
    expect((await refreshIfDue(h.deps)).outcome).toBe("refreshed")
    expect(authConfHasToken(h.conf())).toBe(true)
    expect(h.deps.memory.pendingRefresh).toBe("rt-rotated")
    expect(store.value).toBe("rt-1")
    expect((await readState(h.home))?.lastError).toContain("refresh token not saved")
    expect((await synapseReport(h.deps, h.deps.exec)).pendingSave).toBe(true)
    // Next refresh uses the in-memory token, not the stale stored one.
    let sent = ""
    h.deps.fetch = async (_url, init) => ((sent = new URLSearchParams(String(init.body)).get("refresh_token") ?? ""), ok("rt-3"))
    h.advance(900_000)
    await refreshIfDue(h.deps)
    expect(sent).toBe("rt-rotated")
    store.heal()
    await refreshIfDue(h.deps)
    expect(h.deps.memory.pendingRefresh).toBeUndefined()
    expect(store.value).toBe("rt-3")
    expect((await readState(h.home))?.lastError).toBeUndefined()
  })
})

describe("refresh-token store", () => {
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

  test("DPAPI store: a missing file reads as none; a failing decrypt throws (not 'none'); off Windows fails closed", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocd-dpapi-"))
    const broken = dpapiStore(path.join(dir, "refresh.dpapi"), async (script) => {
      if (script.includes("::Protect(")) return "QUJD"
      throw new Error("DPAPI call failed (exit 1)")
    }, "win32")
    expect(await broken.read()).toBeUndefined()
    await broken.write("rt")
    expect(broken.read()).rejects.toThrow("DPAPI")
    expect(dpapiStore(path.join(dir, "x.dpapi"), async () => "x", "linux").write("rt")).rejects.toThrow("Windows DPAPI")
  })
})
