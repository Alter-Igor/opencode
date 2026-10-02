// WS2 (#48): renewal timing, one refresh at a time across bridges (the real start-lock on a temp
// home), the two kinds of failure (review M2), a store that cannot save (M1), and the store itself.
// Keystone and docker are fakes.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { silentLogger } from "../src/shared/log.ts"
import { defaultConfig } from "../src/shared/config.ts"
import { frontServersFor } from "../src/guard/egress.ts"
import type { Exec } from "../src/supervisor/docker.ts"
import { nodeLeaseFs } from "../src/supervisor/leases.ts"
import { nodeProcessProbe } from "../src/supervisor/process.ts"
import { withStartLock } from "../src/supervisor/start-lock.ts"
import { authConf, authConfHasToken, authConfPath, ensureAuthConf, isAuthConf, writeAuthConf } from "../src/synapse/auth-conf.ts"
import { refreshFraction } from "../src/synapse/index.ts"
import { RETRY_BASE_MS, backoffMs, refreshIfDue } from "../src/synapse/refresh.ts"
import { synapseReport } from "../src/synapse/report.ts"
import { createHash } from "node:crypto"
import { synapseLine } from "../src/tools/doctor.ts"
import { dpapiStore, memoryStore, type PowerShell, type SecretStore } from "../src/synapse/secret-store.ts"
import { FRONT_RELOAD, adopt, isDue, readState, refreshAt, type SynapseDeps } from "../src/synapse/token-manager.ts"
import type { Fetch } from "../src/synapse/keystone-token.ts"
import { jwt } from "./synapse-fixture.ts"
import { generationExec } from "./front-generation-fixture.ts"

const ACCESS = jwt({ sub: "oid-1", email: "owner@example.test", act: { sub: "service:opencode" } })
const ok = (refresh = "rt-rotated") => new Response(JSON.stringify({ access_token: ACCESS, refresh_token: refresh, expires_in: 1000 }), { status: 200 })

function harness(over: Partial<SynapseDeps> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ocd-synapse-"))
  const calls = { fetch: 0, exec: [] as string[][] }
  let clock = 1_000_000
  let reply: () => Response = () => ok()
  // front: `front-reload` exits with `docker.reload` (0 reloaded, 3 files changed, 4 nginx -t refused);
  // The running worker, rather than a written receipt, attests the immutable loaded files.
  const docker: { reload: number; running: string; loadedSha?: string; loadedAuth?: string } = { reload: 0, running: "true" }
  const exec: Exec = async (argv) => {
    calls.exec.push(argv)
    if (argv.includes(FRONT_RELOAD)) {
      if (docker.reload === 0) {
        docker.loadedAuth = readFileSync(authConfPath(path.join(home, "front")), "utf8")
        docker.loadedSha = createHash("sha256").update(docker.loadedAuth).digest("hex")
      }
      return { code: docker.reload, stdout: "", stderr: docker.reload ? "front-reload: refused\n" : "" }
    }
    if (argv.includes("{{.State.Running}}")) return { code: 0, stdout: `${docker.running}\n`, stderr: "" }
    if (!docker.loadedSha) return { code: 1, stdout: "", stderr: "no loaded worker" }
    const servers = frontServersFor(defaultConfig({}))
    return generationExec(servers, docker.loadedAuth ?? readFileSync(authConfPath(path.join(home, "front")), "utf8"), `${"1".repeat(32)} ${createHash("sha256").update(servers).digest("hex")} ${docker.loadedSha}`)(argv)
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
    memory: { id: "bridge-a" },
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
  return { deps, calls, home, docker, clock: () => clock, signedIn, setReply: (fn: () => Response) => (reply = fn), advance: (ms: number) => (clock += ms), conf: () => readFileSync(authConfPath(deps.frontDir), "utf8") }
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
    // Review M1: only the baked script, which checks the files before `nginx -t` and the reload.
    expect(h.calls.exec).toEqual([["docker", "exec", "ocd-test-front", "/usr/local/bin/front-reload"]])
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
    expect(h.deps.memory.pendingRefresh?.token).toBe("rt-rotated")
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

describe("N1: an unsaved refresh token is never used stale, and never saved over a newer one", () => {
  test("(a) while bridge A holds the rotated token unsaved, bridge B waits instead of refreshing with the stale stored one", async () => {
    const store = flakyStore("rt-1", { write: true })
    const h = harness({ store })
    await h.signedIn()
    h.advance(800_000)
    expect((await refreshIfDue(h.deps)).outcome).toBe("refreshed") // A: rt-rotated unsaved, marker set
    expect(await readState(h.home)).toMatchObject({ pendingBy: "bridge-a" })
    const b: SynapseDeps = { ...h.deps, memory: { id: "bridge-b" } }
    h.advance(700_000)
    await refreshIfDue(h.deps) // A ticks: not due, save fails again, marker refreshed
    h.advance(100_000) // now due
    const sent: string[] = []
    const record: Fetch = async (_url, init) => (sent.push(new URLSearchParams(String(init.body)).get("refresh_token") ?? ""), ok("rt-3"))
    h.deps.fetch = record
    b.fetch = record
    const fromB = await refreshIfDue(b)
    expect(fromB.error).toContain("another bridge holds an unsaved refresh token")
    expect(sent).toEqual([]) // B never used the stale stored rt-1
    expect((await refreshIfDue(h.deps)).outcome).toBe("refreshed")
    expect(sent).toEqual(["rt-rotated"])
  })

  test("(b) after a new sign-in elsewhere, A drops its stale pending token instead of saving it over the new one", async () => {
    const store = flakyStore("rt-1", { write: true })
    const h = harness({ store })
    await h.signedIn()
    h.advance(800_000)
    await refreshIfDue(h.deps) // A: rt-rotated pending
    store.heal()
    h.advance(5_000)
    const b: SynapseDeps = { ...h.deps, memory: { id: "bridge-b" } }
    await b.lock(() => adopt(b, { accessToken: ACCESS, refreshToken: "rt-new", expiresInSec: 1000 })) // the owner signs in again via B
    expect(store.value).toBe("rt-new")
    await refreshIfDue(h.deps) // A's tick: its pending token belongs to an older set
    expect(h.deps.memory.pendingRefresh).toBeUndefined()
    expect(store.value).toBe("rt-new")
  })

  test("needs sign-in drops a pending token too", async () => {
    const store = flakyStore("rt-1", { write: true })
    const h = harness({ store })
    await h.signedIn()
    h.advance(800_000)
    await refreshIfDue(h.deps)
    h.deps.fetch = async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    h.advance(800_000)
    expect((await refreshIfDue(h.deps)).outcome).toBe("failed_closed")
    store.heal()
    await refreshIfDue(h.deps)
    expect(store.value).toBe("rt-1")
    expect(h.deps.memory.pendingRefresh).toBeUndefined()
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
    await expect(broken.read()).rejects.toThrow("DPAPI")
    await expect(dpapiStore(path.join(dir, "x.dpapi"), async () => "x", "linux").write("rt")).rejects.toThrow("Windows DPAPI")
  })
})

describe("review M1 / M3: the reload goes through front-reload, and its result is recorded", () => {
  test("a refusal (files changed) is config_changed, is recorded with its time, and the doctor is not ok", async () => {
    const h = harness()
    await h.signedIn()
    expect((await synapseReport(h.deps, h.deps.exec)).loadedSinceWrite).toBe(true)
    h.docker.reload = 3
    // A new access token, so the include changes (front still holds the old one: N2's sha differs).
    const next = jwt({ sub: "oid-1", email: "owner@example.test", act: { sub: "service:opencode" }, iat: 2 })
    h.setReply(() => new Response(JSON.stringify({ access_token: next, refresh_token: "rt-2", expires_in: 1000 }), { status: 200 }))
    h.advance(800_000)
    expect(await refreshIfDue(h.deps)).toEqual({ outcome: "refreshed", reload: "config_changed" })
    const state = await readState(h.home)
    expect(state?.lastReload).toEqual({ result: "config_changed", at: h.clock() })
    expect(state?.includeAt).toBe(h.clock())
    const report = await synapseReport(h.deps, h.deps.exec)
    expect(report).toMatchObject({ loadedSinceWrite: false, lastReload: { result: "config_changed" }, ok: false })
    expect(synapseLine(report)).toContain("front has NOT loaded the include written last (last reload: config_changed")
  })

  test("nginx -t refused while front runs: config_invalid; front gone: front_not_running", async () => {
    const h = harness()
    h.docker.reload = 4
    expect(await h.signedIn()).toBe("config_invalid")
    h.docker.running = "false"
    expect(await h.signedIn()).toBe("front_not_running")
    expect((await readState(h.home))?.lastReload?.result).toBe("front_not_running")
  })

  test("loaded means the running worker attests the host include's hash; no clock is involved", async () => {
    const h = harness()
    h.docker.reload = 1
    h.docker.running = "false"
    await h.signedIn()
    // No worker acknowledgement: not loaded, whatever the clocks say.
    expect((await synapseReport(h.deps, h.deps.exec)).loadedSinceWrite).toBe(false)
    // A worker from the restarted front acknowledges THIS include: loaded.
    h.docker.loadedSha = createHash("sha256").update(h.conf()).digest("hex")
    expect((await synapseReport(h.deps, h.deps.exec)).loadedSinceWrite).toBe(true)
    // It acknowledges another include: not loaded. A garbled response counts as none.
    h.docker.loadedSha = "0".repeat(64)
    expect((await synapseReport(h.deps, h.deps.exec)).loadedSinceWrite).toBe(false)
    h.docker.loadedSha = "not-a-sha"
    expect((await synapseReport(h.deps, h.deps.exec)).loadedSinceWrite).toBe(false)
  })

  test("a failure kept retrying keeps the reload record (retryLater rebuilds the state)", async () => {
    const h = harness()
    await h.signedIn()
    h.setReply(() => new Response("{}", { status: 503 }))
    h.advance(900_000)
    expect((await refreshIfDue(h.deps)).outcome).toBe("retrying")
    expect((await readState(h.home))?.lastReload?.result).toBe("reloaded")
  })
})

describe("review L5: the include is created only when missing; an empty include is its own state", () => {
  test("ensureAuthConf never replaces a token include, nor one it cannot read; it creates a missing one", async () => {
    const h = harness()
    await writeAuthConf(h.deps.frontDir, ACCESS)
    await ensureAuthConf(h.deps.frontDir)
    expect(authConfHasToken(h.conf())).toBe(true)
    const other = path.join(h.home, "front2")
    await ensureAuthConf(other)
    expect(readFileSync(authConfPath(other), "utf8")).toBe(authConf(undefined))
    // Unreadable (here: a folder in its place): left alone, never "repaired" over a write in flight.
    const odd = path.join(h.home, "front3")
    mkdirSync(authConfPath(odd), { recursive: true })
    await ensureAuthConf(odd)
    // A damaged file is still made the empty one (fail closed).
    writeFileSync(authConfPath(other), "set $x 1;\n")
    await ensureAuthConf(other)
    expect(readFileSync(authConfPath(other), "utf8")).toBe(authConf(undefined))
  })

  test("signed in, not expired, include empty: include_empty (not EXPIRED), and the next tick writes it again", async () => {
    const h = harness()
    await h.signedIn()
    await ensureAuthConf(h.deps.frontDir)
    await writeAuthConf(h.deps.frontDir, undefined)
    const report = await synapseReport(h.deps, h.deps.exec)
    expect(report.state).toBe("include_empty")
    expect(synapseLine(report)).not.toContain("EXPIRED")
    expect(synapseLine(report)).toContain("front's include has NO token")
    expect((await refreshIfDue(h.deps)).outcome).toBe("refreshed")
    expect(authConfHasToken(h.conf())).toBe(true)
  })
})
