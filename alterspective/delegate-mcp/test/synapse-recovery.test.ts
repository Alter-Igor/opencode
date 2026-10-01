import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { silentLogger } from "../src/shared/log.ts"
import { refreshIfDue } from "../src/synapse/refresh.ts"
import { dpapiStore, memoryStore } from "../src/synapse/secret-store.ts"
import { adopt, FRONT_RELOAD, readState, stateFile, writeState, type SynapseDeps } from "../src/synapse/token-manager.ts"
import { jwt } from "./synapse-fixture.ts"

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocd-recovery-"))
  homes.push(home)
  const store = memoryStore("test-original")
  const calls = { refresh: 0, reload: 0, reloadExit: 0 }
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
      return { code: 0, stdout: "true", stderr: "" }
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
