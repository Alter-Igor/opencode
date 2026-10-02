// #67 step 1, review cycle 1: the rotated refresh token must survive everything that can go wrong
// AFTER Keystone rotated it (an unusable access token, a reply the SDK would reject), the pending
// marker must be judged by the holder's liveness (not by time alone), and the tick must survive a
// stale lock or a throwing connection list. Token assertions are booleans only.
import { afterEach, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { readKsState, writeKsState } from "../src/keystone-auth/state.ts"
import { refreshConnection, refreshDue, savePendingRefresh, signIn, startKeystoneRefreshLoop, type KeystoneAuthDeps } from "../src/keystone-auth/manager.ts"
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

test("a live holder's recent marker is honoured; a reused pid's marker is not", async () => {
  const h = await harness()
  await signedIn(h)
  h.clock.now += DUE
  const state = await readKsState(h.home, "rag-read")
  if (!state) throw new Error("no state")
  h.processes.set(4242, 777)
  await writeKsState(h.home, { ...state, pendingBy: "4242-other", pendingPid: 4242, pendingStartedAt: 777, pendingAt: h.clock.now })
  h.clock.now += 5 * 60_000
  expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("waiting")
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

test("an alive holder that keeps retrying refreshes its marker, so peers keep waiting past 10 minutes", async () => {
  const h = await harness()
  await signedIn(h)
  const shared = h.stores.get("rag-read")
  if (!shared) throw new Error("no store")
  const a: KeystoneAuthDeps = { ...h.deps, store: () => ({ ...shared, write: async () => { throw new Error("test store write failure") } }) }
  h.clock.now += DUE
  expect((await refreshConnection(a, "rag-read")).outcome).toBe("pending_save")
  for (let i = 0; i < 3; i++) {
    h.clock.now += 6 * 60_000
    expect((await refreshConnection(a, "rag-read")).outcome).toBe("pending_save")
  }
  // The old bearer is past expiry by now, so the waiting peer reports "expired" (credential
  // emptied), but it neither refreshes nor fails closed: the holder still owns the live token.
  const peer = await refreshConnection(h.peer("test-bridge-b"), "rag-read")
  expect(peer.outcome).toBe("expired")
  expect(peer.error).toContain("another bridge holds an unsaved refresh token")
  expect(h.keystone.calls.refresh).toBe(1)
  expect((await readKsState(h.home, "rag-read"))?.needsSignIn).toBeUndefined()
})

test("an alive holder that STOPPED retrying with an unsaved token: the peer fails closed and never reuses the spent token", async () => {
  const h = await harness()
  await signedIn(h)
  const shared = h.stores.get("rag-read")
  if (!shared) throw new Error("no store")
  const a: KeystoneAuthDeps = { ...h.deps, store: () => ({ ...shared, write: async () => { throw new Error("test store write failure") } }) }
  h.clock.now += DUE
  expect((await refreshConnection(a, "rag-read")).outcome).toBe("pending_save")
  // A is alive (same process) but no longer ticks this connection.
  h.clock.now += 11 * 60_000
  const peer = await refreshConnection(h.peer("test-bridge-b"), "rag-read")
  expect(peer.outcome).toBe("needs_sign_in")
  expect(h.keystone.calls.refresh).toBe(1)
  expect(h.published.at(-1)?.bearer).toBeUndefined()
  expect((await readKsState(h.home, "rag-read"))?.needsSignIn).toBe(true)
})

test("a stale marker whose save did not fail (it may have completed): the peer refreshes with the stored token", async () => {
  const h = await harness()
  await signedIn(h)
  h.clock.now += DUE
  const state = await readKsState(h.home, "rag-read")
  if (!state) throw new Error("no state")
  await writeKsState(h.home, { ...state, pendingBy: "test-bridge-x", pendingPid: process.pid, pendingStartedAt: 1, pendingAt: h.clock.now })
  h.clock.now += 11 * 60_000
  expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("refreshed")
  expect(h.keystone.calls.refresh).toBe(1)
})

test("a redirect from the token endpoint is refused: the refresh token is never re-sent elsewhere", async () => {
  const h = await harness()
  await signedIn(h)
  h.keystone.redirectToken = "https://elsewhere.example.test/steal"
  h.clock.now += DUE
  expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("retrying")
  expect(h.keystone.redirectedBodies).toHaveLength(0)
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

/** Bridge A whose store refuses writes until `fixed` is set; same store value as the harness. */
function flakyHolder(h: Harness) {
  const shared = h.stores.get("rag-read")
  if (!shared) throw new Error("no store")
  const control = { fixed: false }
  const write = shared.write.bind(shared)
  const deps: KeystoneAuthDeps = { ...h.deps, store: () => ({ ...shared, write: async (v: string) => {
    if (!control.fixed) throw new Error("test store write failure")
    await write(v)
  } }) }
  return { deps, control, shared }
}

test("a successful save clears the failed-save flag at once, so a later silent holder never makes a peer fail closed", async () => {
  const h = await harness()
  await signedIn(h)
  const a = flakyHolder(h)
  h.clock.now += DUE
  expect((await refreshConnection(a.deps, "rag-read")).outcome).toBe("pending_save")
  expect((await readKsState(h.home, "rag-read"))?.pendingSaveFailed).toBe(true)
  // The save alone succeeds (as if the commit's state write after it then failed).
  a.control.fixed = true
  expect(await savePendingRefresh(a.deps, "rag-read")).toBe(true)
  const after = await readKsState(h.home, "rag-read")
  expect(after?.pendingSaveFailed).toBeUndefined()
  expect(after?.pendingBy).toBe("test-bridge-a")
  // The holder goes silent: the peer refreshes with the (valid) stored token, it does not fail closed.
  h.clock.now += 11 * 60_000
  expect((await refreshConnection(h.peer("test-bridge-b"), "rag-read")).outcome).toBe("refreshed")
  expect((await readKsState(h.home, "rag-read"))?.needsSignIn).toBeUndefined()
})

test("the holder recovers after a peer failed closed: its saved token is committed and published", async () => {
  const h = await harness()
  await signedIn(h)
  const a = flakyHolder(h)
  h.clock.now += DUE
  expect((await refreshConnection(a.deps, "rag-read")).outcome).toBe("pending_save")
  const held = h.keystone.issued[2]
  h.clock.now += 11 * 60_000
  expect((await refreshConnection(h.peer("test-bridge-b"), "rag-read")).outcome).toBe("needs_sign_in")
  a.control.fixed = true
  h.clock.now += 15_000
  expect((await refreshConnection(a.deps, "rag-read")).outcome).toBe("refreshed")
  const state = await readKsState(h.home, "rag-read")
  expect(state?.needsSignIn).toBeUndefined()
  expect(state?.pendingBy).toBeUndefined()
  expect(state?.pendingSaveFailed).toBeUndefined()
  expect(h.published.at(-1)?.bearer === held).toBe(true)
  expect(a.shared.value === h.keystone.issued[3]).toBe(true)
})
