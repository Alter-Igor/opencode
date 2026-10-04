import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { silentLogger } from "../src/shared/log.ts"
import { RELOAD_RETRY_MAX_MS, refreshIfDue, reloadBackoffMs } from "../src/synapse/refresh.ts"
import { dpapiStore, memoryStore } from "../src/synapse/secret-store.ts"
import { adopt, FRONT_RELOAD, readState, stateFile, writeState, type Reload, type SynapseDeps } from "../src/synapse/token-manager.ts"
import { authConfPath } from "../src/synapse/auth-conf.ts"
import { UnusableTokenError, rotatedRefreshToken } from "../src/synapse/keystone-token.ts"
import { jwt } from "./synapse-fixture.ts"

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocd-recovery-"))
  homes.push(home)
  const store = memoryStore("test-original")
  const calls = { refresh: 0, reload: 0, reloadExit: 0, running: true }
  const clock = { now: 1_000_000 }
  const accessToken = jwt({ sub: "test-owner" })
  const deps: SynapseDeps = {
    home,
    frontDir: path.join(home, "front"),
    origin: "https://identity.example.test",
    frontContainer: "test-front",
    store,
    memory: { id: "test-bridge" },
    secrets: async () => ({ brokerKey: "test-broker", clientSecret: "test-client" }),
    fetch: async () => {
      calls.refresh++
      return Response.json({ access_token: accessToken, refresh_token: "test-rotated", expires_in: 1000 })
    },
    exec: async (argv) => {
      if (argv.includes(FRONT_RELOAD)) {
        calls.reload++
        return { code: calls.reloadExit, stdout: "", stderr: "" }
      }
      return { code: 0, stdout: String(calls.running), stderr: "" }
    },
    lock: (fn) => fn(),
    now: () => clock.now,
    refreshFraction: 0.8,
    opener: () => {},
    log: silentLogger,
  }
  await adopt(deps, { accessToken, expiresInSec: 1000 })
  calls.reload = 0
  clock.now += 800_000
  return { home, deps, store, calls, clock }
}

test("a refresh-store filesystem error is not a missing sign-in", async () => {
  const h = await fixture()
  const file = path.join(h.home, "blocked.dpapi")
  await mkdir(file)
  const store = dpapiStore(file, async () => "unused", "win32")
  await expect(store.read()).rejects.toThrow()
  h.deps.store = store
  expect((await refreshIfDue(h.deps)).outcome).toBe("retrying")
  expect((await readState(h.home))?.needsSignIn).toBeUndefined()
})

test("a rotated refresh token survives failure to publish the front include", async () => {
  const h = await fixture()
  const blocked = path.join(h.home, "blocked-front")
  await writeFile(blocked, "not a directory")
  h.deps.frontDir = blocked
  await refreshIfDue(h.deps)
  // Only a boolean is asserted, so a failing assertion never prints a credential.
  expect(h.store.value === "test-rotated" || h.deps.memory.pendingRefresh?.token === "test-rotated").toBe(true)
})

test("the rotated token is saved before a state-file failure", async () => {
  const h = await fixture()
  const file = stateFile(h.home)
  h.deps.fetch = async () => {
    await rm(file)
    await mkdir(file)
    return Response.json({ access_token: jwt({ sub: "test-owner" }), refresh_token: "test-rotated", expires_in: 1000 })
  }
  await refreshIfDue(h.deps).catch(() => undefined)
  expect(h.store.value === "test-rotated" || h.deps.memory.pendingRefresh?.token === "test-rotated").toBe(true)
})

test("an unsaved rotation still blocks peers when publishing fails, and recovers after repair", async () => {
  const h = await fixture()
  const front = h.deps.frontDir
  const blocked = path.join(h.home, "blocked-front")
  await writeFile(blocked, "not a directory")
  h.deps.frontDir = blocked
  const write = h.store.write.bind(h.store)
  h.store.write = async () => { throw new Error("test store write failure") }
  await refreshIfDue(h.deps)
  expect((await readState(h.home))?.pendingBy).toBe("test-bridge")
  h.clock.now += 30_000
  const peer = await refreshIfDue({ ...h.deps, memory: { id: "test-peer" } })
  expect(peer.error).toContain("another bridge holds an unsaved refresh token")
  expect(h.calls.refresh).toBe(1)
  h.deps.frontDir = front
  h.store.write = write
  h.deps.fetch = async (_url, init) => {
    const current = init.body instanceof URLSearchParams && init.body.get("refresh_token") === "test-rotated"
    expect(current).toBe(true)
    return Response.json({ access_token: jwt({ sub: "test-owner" }), refresh_token: "test-next", expires_in: 1000 })
  }
  expect((await refreshIfDue(h.deps)).outcome).toBe("refreshed")
  expect(h.store.value === "test-next").toBe(true)
  expect(await readFile(stateFile(h.home), "utf8")).not.toContain("test-next")
})

test("a transient reload failure is retried before the new token's next renewal", async () => {
  const h = await fixture()
  h.calls.reloadExit = 4
  expect((await refreshIfDue(h.deps)).reload).toBe("config_invalid")
  h.calls.reloadExit = 0
  h.clock.now += 15_000
  await refreshIfDue(h.deps)
  expect(h.calls.reload).toBe(2)
  expect(h.calls.refresh).toBe(1)
})

test.each<{ exit: number; running: boolean; result: Reload }>([
  { exit: 1, running: false, result: "front_not_running" },
  { exit: 3, running: true, result: "config_changed" },
])("a reload that cannot clear by itself ($result) is not retried on every tick", async ({ exit, running, result }) => {
  const h = await fixture()
  h.calls.reloadExit = exit
  h.calls.running = running
  expect((await refreshIfDue(h.deps)).reload).toBe(result)
  for (let tick = 0; tick < 8; tick++) {
    h.clock.now += 15_000
    await refreshIfDue(h.deps)
  }
  expect(h.calls.reload).toBe(1)
  // A real event (here a new token) still reloads.
  h.calls.reloadExit = 0
  h.calls.running = true
  await adopt(h.deps, { accessToken: jwt({ sub: "test-owner" }), expiresInSec: 1000 })
  expect(h.calls.reload).toBe(2)
})

test("front-reload exits map to results: 6 config_invalid, 7 unverified, 8 busy", async () => {
  const h = await fixture()
  for (const [exit, result] of [[6, "config_invalid"], [7, "unverified"], [8, "busy"]] as const) {
    h.calls.reloadExit = exit
    expect(await adopt(h.deps, { accessToken: jwt({ sub: "test-owner" }), expiresInSec: 1000 })).toBe(result)
  }
})

test("a transient reload failure backs off, doubling from one tick, and success resets it", async () => {
  const h = await fixture()
  h.calls.reloadExit = 7
  expect((await refreshIfDue(h.deps)).reload).toBe("unverified")
  const reloadsAfter = async (ms: number) => {
    h.clock.now += ms
    await refreshIfDue(h.deps)
    return h.calls.reload
  }
  expect(await reloadsAfter(15_000)).toBe(2) // 15 s after the first failure
  expect(await reloadsAfter(15_000)).toBe(2) // now waits 30 s
  expect(await reloadsAfter(15_000)).toBe(3)
  expect(await reloadsAfter(45_000)).toBe(3) // now waits 60 s
  expect(await reloadsAfter(15_000)).toBe(4)
  expect((await readState(h.home))?.lastReload?.failures).toBe(4)
  expect(reloadBackoffMs(20)).toBe(RELOAD_RETRY_MAX_MS)
  h.calls.reloadExit = 0
  expect(await reloadsAfter(120_000)).toBe(5)
  expect((await readState(h.home))?.lastReload).toEqual({ result: "reloaded", at: h.clock.now })
  expect(await reloadsAfter(15_000)).toBe(5)
  // The next failure starts again at one tick.
  h.calls.reloadExit = 8
  expect(await adopt(h.deps, { accessToken: jwt({ sub: "test-owner" }), expiresInSec: 1000 })).toBe("busy")
  expect((await readState(h.home))?.lastReload?.failures).toBe(1)
  expect(await reloadsAfter(15_000)).toBe(7)
  expect(h.calls.refresh).toBe(1)
})

test("a new sign-in retains its refresh token after an earlier sign-in failed closed", async () => {
  const h = await fixture()
  await writeState(h.home, { obtainedAt: 1, expiresAt: 2, needsSignIn: true })
  await adopt(h.deps, { accessToken: jwt({ sub: "test-owner" }), refreshToken: "test-new-signin", expiresInSec: 1000 })
  expect(h.store.value === "test-new-signin").toBe(true)
  expect((await readState(h.home))?.needsSignIn).toBeUndefined()
})

test.each(["missing", "older"])("an unsaved rotation survives state publication failure and %s state after repair", async (repair) => {
  const h = await fixture()
  const file = stateFile(h.home)
  const previous = await readFile(file, "utf8")
  const write = h.store.write.bind(h.store)
  h.store.write = async () => { throw new Error("test store write failure") }
  h.deps.fetch = async () => {
    await rm(file)
    await mkdir(file)
    return Response.json({ access_token: jwt({ sub: "test-owner" }), refresh_token: "test-rotated", expires_in: 1000 })
  }
  await refreshIfDue(h.deps).catch(() => undefined)
  h.store.write = write
  // Storage may heal before state publication does. Keep recovery memory through both steps.
  await refreshIfDue(h.deps).catch(() => undefined)
  expect(h.deps.memory.pendingRefresh?.token === "test-rotated").toBe(true)
  await rm(file, { recursive: true })
  if (repair === "older") await writeFile(file, previous)
  h.clock.now += 30_000
  h.deps.fetch = async (_url, init) => {
    expect(init.body instanceof URLSearchParams && init.body.get("refresh_token") === "test-rotated").toBe(true)
    return Response.json({ access_token: jwt({ sub: "test-owner" }), refresh_token: "test-next", expires_in: 1000 })
  }
  expect((await refreshIfDue(h.deps)).outcome).toBe("refreshed")
  expect(h.store.value === "test-next").toBe(true)
})

test("a later sign-in replaces an unpublished rotation without an old bridge overwriting it", async () => {
  const h = await fixture()
  const file = stateFile(h.home)
  const write = h.store.write.bind(h.store)
  h.store.write = async () => { throw new Error("test store write failure") }
  h.deps.fetch = async () => {
    await rm(file)
    await mkdir(file)
    return Response.json({ access_token: jwt({ sub: "test-owner" }), refresh_token: "test-rotated", expires_in: 1000 })
  }
  await refreshIfDue(h.deps).catch(() => undefined)
  await rm(file, { recursive: true })
  h.store.write = write
  h.clock.now += 30_000
  await adopt({ ...h.deps, memory: { id: "test-new-bridge" } }, { accessToken: jwt({ sub: "test-owner" }), refreshToken: "test-new-signin", expiresInSec: 1000 })
  await refreshIfDue(h.deps)
  expect(h.store.value === "test-new-signin").toBe(true)
  expect(h.deps.memory.pendingRefresh).toBeUndefined()
})

// #68: Keystone answered 2xx and rotated, but its access token cannot be used. The stored refresh
// token is spent, so the rotated one must be kept and the next refresh must use it.
const unusableReplies: { name: string; body: () => Record<string, unknown> }[] = [
  { name: "the PC clock runs an hour fast (JWT exp already passed)", body: () => ({ access_token: jwt({ sub: "test-owner", exp: Math.floor(Date.now() / 1000) - 3600 }), refresh_token: "test-rotated", expires_in: 3600 }) },
  { name: "Keystone issued a nearly expired token", body: () => ({ access_token: jwt({ sub: "test-owner" }), refresh_token: "test-rotated", expires_in: 30 }) },
  { name: "the access token has a shape the bridge does not recognise", body: () => ({ access_token: "test-not-a-jwt", refresh_token: "test-rotated", expires_in: 1000 }) },
  { name: "the reply has no access token", body: () => ({ refresh_token: "test-rotated", expires_in: 1000 }) },
]

for (const reply of unusableReplies) {
  test(`#68: ${reply.name}: the rotated refresh token is kept, nothing is published, the retry spends it`, async () => {
    const h = await fixture()
    const include = await readFile(authConfPath(h.deps.frontDir), "utf8")
    h.deps.fetch = async () => {
      h.calls.refresh++
      return Response.json(reply.body())
    }
    const first = await refreshIfDue(h.deps)
    expect(first.outcome).toBe("retrying")
    // Booleans only, so a failing assertion never prints a credential.
    expect(h.store.value === "test-rotated").toBe(true)
    expect((await readFile(authConfPath(h.deps.frontDir), "utf8")) === include).toBe(true)
    expect(h.calls.reload).toBe(0)
    expect((await readState(h.home))?.needsSignIn).toBeUndefined()

    h.clock.now += 31_000
    let spent = ""
    h.deps.fetch = async (_url, init) => {
      spent = init.body instanceof URLSearchParams ? (init.body.get("refresh_token") ?? "") : ""
      return Response.json({ access_token: jwt({ sub: "test-owner" }), refresh_token: "test-next", expires_in: 1000 })
    }
    expect((await refreshIfDue(h.deps)).outcome).toBe("refreshed")
    expect(spent === "test-rotated").toBe(true)
    expect(h.store.value === "test-next").toBe(true)
  })
}

test("#68: an unusable token whose rotated refresh token cannot be saved keeps it in memory for the retry", async () => {
  const h = await fixture()
  const write = h.store.write.bind(h.store)
  h.store.write = async () => { throw new Error("test store write failure") }
  h.deps.fetch = async () => Response.json({ access_token: "test-not-a-jwt", refresh_token: "test-rotated", expires_in: 1000 })
  expect((await refreshIfDue(h.deps)).outcome).toBe("retrying")
  expect(h.deps.memory.pendingRefresh?.token === "test-rotated").toBe(true)
  expect((await readState(h.home))?.pendingBy).toBe("test-bridge")
  h.store.write = write
  h.clock.now += 31_000
  let spent = ""
  h.deps.fetch = async (_url, init) => {
    spent = init.body instanceof URLSearchParams ? (init.body.get("refresh_token") ?? "") : ""
    return Response.json({ access_token: jwt({ sub: "test-owner" }), refresh_token: "test-next", expires_in: 1000 })
  }
  expect((await refreshIfDue(h.deps)).outcome).toBe("refreshed")
  expect(spent === "test-rotated").toBe(true)
  expect(h.store.value === "test-next").toBe(true)
})

test("#68: an unusable reply with no refresh token changes nothing stored (the old one may still be valid)", async () => {
  const h = await fixture()
  const before = h.store.value
  h.deps.fetch = async () => Response.json({ access_token: "test-not-a-jwt", expires_in: 1000 })
  expect((await refreshIfDue(h.deps)).outcome).toBe("retrying")
  expect(h.store.value === before).toBe(true)
  expect(h.deps.memory.pendingRefresh).toBeUndefined()
})

test("#68: the error carrying a rotated token never exposes it when logged or serialised", () => {
  // Built at run time: Bun.inspect prints the error's stack with its source lines, and a literal
  // there would show up even though the error itself does not hold the token.
  const token = ["test", "secret", "rotated"].join("-")
  const error = new UnusableTokenError(token, "message", "action", "detail")
  expect(rotatedRefreshToken(error) === token).toBe(true)
  expect(rotatedRefreshToken(new Error("other"))).toBeUndefined()
  const views = [JSON.stringify(error), JSON.stringify(error.toResult()), String(error), Object.keys(error).join(","), Bun.inspect(error)]
  expect(views.some((view) => view.includes(token))).toBe(false)
  expect(error.code).toBe("upstream_error")
})
