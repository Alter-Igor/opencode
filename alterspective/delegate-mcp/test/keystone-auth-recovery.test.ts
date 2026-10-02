// #67 step 1, review cycle 1: the rotated refresh token must survive everything that can go wrong
// AFTER Keystone rotated it (an unusable access token, a reply the SDK would reject), the pending
// marker must be judged by the holder's liveness (not by time alone), and the tick must survive a
// stale lock or a throwing connection list. Token assertions are booleans only.
import { afterEach, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { readKsState, writeKsState } from "../src/keystone-auth/state.ts"
import { refreshConnection, refreshDue, signIn, startKeystoneRefreshLoop, type KeystoneAuthDeps } from "../src/keystone-auth/manager.ts"
import { keystoneAuthStatus } from "../src/keystone-auth/report.ts"
import { synapseLockFile } from "../src/synapse/lock.ts"
import { cleanupHomes, harness, type Harness } from "./keystone-auth-fixture.ts"

afterEach(cleanupHomes)

function approving(deps: KeystoneAuthDeps): KeystoneAuthDeps {
  return {
    ...deps,
    opener: (url) => {
      const u = new URL(url)
      void fetch(`${u.searchParams.get("redirect_uri")}?code=test-code&state=${u.searchParams.get("state")}`).catch(() => undefined)
    },
  }
}

async function signedIn(h: Harness) {
  await signIn(approving(h.deps), "rag-read")
  h.published.length = 0
}

const DUE = 2_880_000

test("an access token with too short a life after rotation: the new refresh token is kept, never the spent one reused", async () => {
  const h = await harness()
  await signedIn(h)
  h.keystone.reply = { expires_in: 30 }
  h.clock.now += DUE
  const first = await refreshConnection(h.deps, "rag-read")
  expect(first.outcome).toBe("retrying")
  const rotated = h.keystone.issued.at(-1)
  expect(h.stores.get("rag-read")?.value === rotated).toBe(true)
  // Nothing unusable reaches front; the old bearer stays until it expires.
  expect(h.published).toHaveLength(0)
  expect((await readKsState(h.home, "rag-read"))?.needsSignIn).toBeUndefined()
  // Next attempt (after the backoff) presents the NEW token: Keystone accepts it.
  h.keystone.reply = {}
  h.clock.now += 60_000
  expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("refreshed")
  expect(h.keystone.tokenRequests.at(-1)?.get("refresh_token") === rotated).toBe(true)
  expect(h.published).toHaveLength(1)
  expect((await readKsState(h.home, "rag-read"))?.needsSignIn).toBeUndefined()
})

test("a reply the SDK schema would reject (access_token not a string) still yields the saved refresh token", async () => {
  const h = await harness()
  await signedIn(h)
  h.keystone.reply = { access_token: 42 }
  h.clock.now += DUE
  expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("retrying")
  expect(h.stores.get("rag-read")?.value === h.keystone.issued.at(-1)).toBe(true)
  expect(h.published).toHaveLength(0)
  h.keystone.reply = {}
  h.clock.now += 60_000
  expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("refreshed")
})

test("a reply without expires_in defaults to one hour (as Synapse) instead of failing", async () => {
  const h = await harness()
  await signedIn(h)
  h.keystone.reply = { expires_in: undefined }
  h.clock.now += DUE
  expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("refreshed")
  expect((await readKsState(h.home, "rag-read"))?.expiresAt).toBe(h.clock.now + 3_600_000)
})

test("the pending marker is written BEFORE the store write is attempted", async () => {
  const h = await harness()
  await signedIn(h)
  const store = h.stores.get("rag-read")
  if (!store) throw new Error("no store")
  let markerSeen = false
  store.write = async () => {
    markerSeen = (await readKsState(h.home, "rag-read"))?.pendingBy === "test-bridge-a"
    throw new Error("test store write failure")
  }
  h.clock.now += DUE
  expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("pending_save")
  expect(markerSeen).toBe(true)
})

test("a live holder's marker is honoured however old; a dead or reused pid's marker is not", async () => {
  const h = await harness()
  await signedIn(h)
  const state = await readKsState(h.home, "rag-read")
  if (!state) throw new Error("no state")
  h.processes.set(4242, 777)
  await writeKsState(h.home, { ...state, pendingBy: "4242-other", pendingPid: 4242, pendingStartedAt: 777, pendingAt: h.clock.now })
  // Far past the old 2-minute window: the holder is alive, so peers still wait.
  h.clock.now += DUE + 60 * 60_000
  expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("expired")
  expect(h.keystone.calls.refresh).toBe(0)
  const [status] = await keystoneAuthStatus(h.deps)
  expect(status?.pendingSave).toBe(true)
  // The pid was reused by another process (different start time): the marker is stale.
  h.processes.set(4242, 777 + 10 * 60_000)
  const [stale] = await keystoneAuthStatus(h.deps)
  expect(stale?.pendingSave).toBe(false)
  await refreshConnection(h.deps, "rag-read")
  expect(h.keystone.calls.refresh).toBe(1)
})

test("a dead process's marker does not block peers", async () => {
  const h = await harness()
  await signedIn(h)
  const state = await readKsState(h.home, "rag-read")
  if (!state) throw new Error("no state")
  await writeKsState(h.home, { ...state, pendingBy: "4343-gone", pendingPid: 4343, pendingStartedAt: 5, pendingAt: h.clock.now })
  h.clock.now += DUE
  await refreshConnection(h.deps, "rag-read")
  expect(h.keystone.calls.refresh).toBe(1)
})

test("a stale lock left by a dead process does not stop the refresh", async () => {
  const h = await harness({ realLock: true })
  await signedIn(h)
  const lock = synapseLockFile(h.home)
  await mkdir(path.dirname(lock), { recursive: true })
  await writeFile(lock, JSON.stringify({ token: "test-dead", pid: 999_999, startedAt: 1, at: new Date().toISOString() }))
  h.clock.now += DUE
  const [r] = await refreshDue(h.deps)
  expect(r?.outcome).toBe("refreshed")
  expect(h.keystone.calls.refresh).toBe(1)
})

test("the loop survives a throwing connection list and keeps ticking", async () => {
  const h = await harness()
  let calls = 0
  const stop = startKeystoneRefreshLoop(h.deps, () => {
    calls++
    if (calls === 1) throw new Error("test list failure")
    return []
  }, 5)
  await new Promise((r) => setTimeout(r, 80))
  stop()
  expect(calls >= 2).toBe(true)
  expect(h.log.lines.some((l) => l.includes("connection list"))).toBe(true)
})
