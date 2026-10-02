// #67 step 1: the host-side Keystone token manager (src/keystone-auth). The box never holds a token:
// the host signs in as its own public OAuth client per connection, keeps the refresh token in the
// DPAPI store, and hands front only the access token through an injected `publish`. Assertions on
// token values are booleans only, so a failing test never prints a credential.
import { afterEach, describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { createServer } from "node:net"
import path from "node:path"
import { keystoneStoreFile, keystoneDpapiStore } from "../src/keystone-auth/store.ts"
import { readKsState, ksStateFile } from "../src/keystone-auth/state.ts"
import { refreshConnection, refreshDue, signIn, type KeystoneAuthDeps } from "../src/keystone-auth/manager.ts"
import { keystoneAuthStatus } from "../src/keystone-auth/report.ts"
import { ORIGIN, SCOPE, cleanupHomes, harness, type Harness } from "./keystone-auth-fixture.ts"

afterEach(cleanupHomes)

/** A loopback port that was free a moment ago. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))))
    })
  })
}

/** The owner "approves" in the browser: the opener calls the loopback redirect with the code. */
function approving(deps: KeystoneAuthDeps, seen: URL[] = [], code = "test-code"): KeystoneAuthDeps {
  return {
    ...deps,
    opener: (url) => {
      const u = new URL(url)
      seen.push(u)
      const redirect = u.searchParams.get("redirect_uri") ?? ""
      void fetch(`${redirect}?code=${code}&state=${u.searchParams.get("state")}`).catch(() => undefined)
    },
  }
}

async function signedIn(h: Harness, id = "rag-read") {
  const result = await signIn(approving(h.deps), id)
  h.published.length = 0
  return result
}

/** Everything the host wrote under <home>/keystone plus every log line, as one text. */
async function hostText(h: Harness): Promise<string> {
  const dir = path.join(h.home, "keystone")
  const files = await readdir(dir).catch(() => [] as string[])
  const contents = await Promise.all(files.map((f) => readFile(path.join(dir, f), "utf8").catch(() => "")))
  return [...contents, ...h.log.lines].join("\n")
}

describe("sign-in", () => {
  test("registers a public client and authorizes with the resource's scopes_supported", async () => {
    const h = await harness()
    const seen: URL[] = []
    const result = await signIn(approving(h.deps, seen), "rag-read")
    expect(result.outcome).toBe("signed_in")
    expect(h.keystone.registrations).toHaveLength(1)
    const reg = h.keystone.registrations[0] ?? {}
    expect(reg.token_endpoint_auth_method).toBe("none")
    expect(reg.scope).toBe(SCOPE)
    expect(seen).toHaveLength(1)
    const authorize = seen[0] as URL
    expect(authorize.origin).toBe(ORIGIN)
    expect(authorize.searchParams.get("scope")).toBe(SCOPE)
    expect(authorize.searchParams.get("resource")).toBe(`${ORIGIN}/mcp/c/rag-read`)
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
    // The code exchange names the same resource (audience-bound token).
    expect(h.keystone.tokenRequests.at(-1)?.get("resource")).toBe(`${ORIGIN}/mcp/c/rag-read`)
  })

  test("saves the refresh token before publishing, and publishes the bearer once", async () => {
    const h = await harness()
    await signIn(approving(h.deps), "rag-read")
    expect(h.published).toHaveLength(1)
    const p = h.published[0]
    expect(p?.connection).toBe("rag-read")
    expect(p?.bearer === h.keystone.issued[0]).toBe(true)
    expect(p?.storeAtPublish === h.keystone.issued[1]).toBe(true)
    const state = await readKsState(h.home, "rag-read")
    expect(state?.clientId).toBe("test-client-1")
    expect(state?.credential).toBe("published")
    expect(state?.expiresAt).toBe(h.clock.now + 3_600_000)
  })

  test("reuses the registered client on a second sign-in", async () => {
    const h = await harness()
    // A fixed port, as in production (LOGIN_PORT): the redirect is the same, so the client is too.
    const port = await freePort()
    const deps = approving({ ...h.deps, loginPort: port })
    await signIn(deps, "rag-read")
    await signIn(deps, "rag-read")
    expect(h.keystone.calls.register).toBe(1)
    expect(h.keystone.calls.code).toBe(2)
    // Another connection gets its own client.
    await signIn(deps, "github")
    expect(h.keystone.calls.register).toBe(2)
  })

  test("refuses an authorization server on another origin (a refresh token never leaves Keystone)", async () => {
    const h = await harness()
    h.keystone.metadata = { token_endpoint: "https://elsewhere.example.test/token" }
    await expect(signIn(approving(h.deps), "rag-read")).rejects.toThrow()
    expect(h.keystone.calls.register).toBe(0)
    expect(h.published).toHaveLength(0)
  })

  test("rejects a connection id that is not a plain slug", async () => {
    const h = await harness()
    await expect(signIn(approving(h.deps), "../x")).rejects.toThrow()
    expect(h.keystone.calls.prm).toBe(0)
  })

  test("a callback with the wrong state is ignored; the right one still completes", async () => {
    const h = await harness()
    const deps: KeystoneAuthDeps = {
      ...h.deps,
      opener: (url) => {
        const u = new URL(url)
        const redirect = u.searchParams.get("redirect_uri") ?? ""
        void (async () => {
          const wrong = await fetch(`${redirect}?code=test-code&state=not-the-state`)
          expect(wrong.status).toBe(400)
          await fetch(`${redirect}?code=test-code&state=${u.searchParams.get("state")}`)
        })().catch(() => undefined)
      },
    }
    expect((await signIn(deps, "rag-read")).outcome).toBe("signed_in")
  })

  test("a refused consent fails the sign-in and publishes nothing", async () => {
    const h = await harness()
    const deps: KeystoneAuthDeps = {
      ...h.deps,
      opener: (url) => {
        const u = new URL(url)
        void fetch(`${u.searchParams.get("redirect_uri")}?error=access_denied&state=${u.searchParams.get("state")}`).catch(() => undefined)
      },
    }
    await expect(signIn(deps, "rag-read")).rejects.toThrow()
    expect(h.published).toHaveLength(0)
  })
})

describe("refresh", () => {
  test("not due: nothing is refreshed or published", async () => {
    const h = await harness()
    await signedIn(h)
    h.clock.now += 60_000
    const [r] = await refreshDue(h.deps)
    expect(r?.outcome).toBe("fresh")
    expect(h.keystone.calls.refresh).toBe(0)
    expect(h.published).toHaveLength(0)
  })

  test("due at the Synapse fraction (0.8): rotates, saves the new refresh token BEFORE publish", async () => {
    const h = await harness()
    await signedIn(h)
    h.clock.now += 2_880_000
    const [r] = await refreshDue(h.deps)
    expect(r?.outcome).toBe("refreshed")
    expect(h.keystone.calls.refresh).toBe(1)
    expect(h.published).toHaveLength(1)
    const newAccess = h.keystone.issued[2]
    const newRefresh = h.keystone.issued[3]
    expect(h.published[0]?.bearer === newAccess).toBe(true)
    expect(h.published[0]?.storeAtPublish === newRefresh).toBe(true)
    expect(h.stores.get("rag-read")?.value === newRefresh).toBe(true)
  })

  test("store write fails: the new access token is NOT published; retries save without another grant", async () => {
    const h = await harness()
    await signedIn(h)
    const store = h.stores.get("rag-read")
    if (!store) throw new Error("no store")
    const write = store.write.bind(store)
    store.write = async () => {
      throw new Error("test store write failure")
    }
    h.clock.now += 2_880_000
    expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("pending_save")
    expect(h.published).toHaveLength(0)
    expect((await readKsState(h.home, "rag-read"))?.pendingBy).toBe("test-bridge-a")
    // More ticks while the store is broken: still no publish, still exactly one grant used.
    for (let i = 0; i < 3; i++) {
      h.clock.now += 15_000
      expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("pending_save")
    }
    expect(h.keystone.calls.refresh).toBe(1)
    expect(h.published).toHaveLength(0)
    // A peer does not refresh with the stale stored token while the marker is fresh.
    const peer = await refreshConnection(h.peer("test-bridge-b"), "rag-read")
    expect(peer.outcome).toBe("waiting")
    // Not even a forced refresh (e.g. a live check) spends the stale stored token.
    expect((await refreshConnection(h.peer("test-bridge-c"), "rag-read", true)).outcome).toBe("waiting")
    expect(h.keystone.calls.refresh).toBe(1)
    // The store recovers: the held token is saved, then published, with no new grant.
    store.write = write
    h.clock.now += 15_000
    expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("refreshed")
    expect(h.keystone.calls.refresh).toBe(1)
    expect(h.published).toHaveLength(1)
    expect(h.published[0]?.bearer === h.keystone.issued[2]).toBe(true)
    expect(h.published[0]?.storeAtPublish === h.keystone.issued[3]).toBe(true)
    const state = await readKsState(h.home, "rag-read")
    expect(state?.pendingBy).toBeUndefined()
    // The set in force is the one issued by the single refresh (60 s ago), not a new one.
    expect(state?.expiresAt).toBe(h.clock.now - 60_000 + 3_600_000)
  })

  test("an unsaved token is dropped once a newer sign-in replaces it (a late save never overwrites)", async () => {
    const h = await harness()
    await signedIn(h)
    const shared = h.stores.get("rag-read")
    if (!shared) throw new Error("no store")
    const failing = { ...shared, write: async () => { throw new Error("test store write failure") } }
    const a: KeystoneAuthDeps = { ...h.deps, store: () => failing }
    h.clock.now += 2_880_000
    expect((await refreshConnection(a, "rag-read")).outcome).toBe("pending_save")
    // The owner signs in again through another bridge while A still holds its unsaved token.
    h.clock.now += 1_000
    expect((await signIn(approving(h.peer("test-bridge-b")), "rag-read")).outcome).toBe("signed_in")
    const newest = h.keystone.issued.at(-1)
    // A's store works again: its token belongs to a superseded set, so it is dropped, not saved.
    h.clock.now += 15_000
    await refreshConnection({ ...a, store: () => shared }, "rag-read")
    expect(shared.value === newest).toBe(true)
    expect(a.memory.held.has("rag-read")).toBe(false)
  })

  test("invalid_grant: needs sign-in, an EMPTY credential is published, and no more attempts", async () => {
    const h = await harness()
    await signedIn(h)
    h.keystone.fail.refresh = "invalid_grant"
    h.clock.now += 2_880_000
    expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("needs_sign_in")
    expect(h.published).toEqual([{ connection: "rag-read", bearer: undefined, storeAtPublish: h.stores.get("rag-read")?.value }])
    const state = await readKsState(h.home, "rag-read")
    expect(state?.needsSignIn).toBe(true)
    expect(state?.credential).toBe("empty")
    h.clock.now += 60_000
    await refreshDue(h.deps)
    expect(h.keystone.calls.refresh).toBe(1)
    expect(h.published).toHaveLength(1)
  })

  test("invalid_client (client revoked): needs sign-in and the client is forgotten", async () => {
    const h = await harness()
    await signedIn(h)
    h.keystone.fail.refresh = "invalid_client"
    h.clock.now += 2_880_000
    expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("needs_sign_in")
    expect((await readKsState(h.home, "rag-read"))?.clientId).toBeUndefined()
    expect(h.published.at(-1)?.bearer).toBeUndefined()
  })

  test("no stored refresh token: needs sign-in", async () => {
    const h = await harness()
    await signedIn(h)
    await h.stores.get("rag-read")?.remove()
    h.clock.now += 2_880_000
    expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("needs_sign_in")
  })

  test("Keystone down: backoff; past expiry the credential is emptied once; a later success restores it", async () => {
    const h = await harness()
    await signedIn(h)
    h.keystone.fail.refresh = "down"
    h.clock.now += 2_880_000
    expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("retrying")
    const first = await readKsState(h.home, "rag-read")
    expect(first?.failures).toBe(1)
    expect(first?.needsSignIn).toBeUndefined()
    // Inside the backoff: no new attempt.
    h.clock.now += 1_000
    await refreshConnection(h.deps, "rag-read")
    expect(h.keystone.calls.refresh).toBe(1)
    expect(h.published).toHaveLength(0)
    // Past expiry: one empty publish, still retrying (not a sign-out).
    h.clock.now += 720_000
    expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("expired")
    expect(h.published).toEqual([{ connection: "rag-read", bearer: undefined, storeAtPublish: h.stores.get("rag-read")?.value }])
    h.clock.now += 1_000
    await refreshConnection(h.deps, "rag-read")
    expect(h.published).toHaveLength(1)
    // Keystone back: refreshed with the same (unconsumed) refresh token, bearer published again.
    h.keystone.fail.refresh = undefined
    h.clock.now += 10 * 60_000
    expect((await refreshConnection(h.deps, "rag-read")).outcome).toBe("refreshed")
    expect(h.published.at(-1)?.bearer === h.keystone.issued.at(-2)).toBe(true)
    expect((await readKsState(h.home, "rag-read"))?.failures).toBeUndefined()
  })

  test("publish fails after a rotation: the token is kept saved and published on a later tick", async () => {
    const h = await harness()
    await signedIn(h)
    let broken = true
    const publish = h.deps.publish
    const deps: KeystoneAuthDeps = { ...h.deps, publish: async (id, bearer) => {
      if (broken) throw new Error("test publish failure")
      await publish(id, bearer)
    } }
    h.clock.now += 2_880_000
    expect((await refreshConnection(deps, "rag-read")).outcome).toBe("retrying")
    expect(h.stores.get("rag-read")?.value === h.keystone.issued[3]).toBe(true)
    expect((await readKsState(h.home, "rag-read"))?.needsPublish).toBe(true)
    broken = false
    h.clock.now += 60_000
    await refreshConnection(deps, "rag-read")
    // Republished from memory: no second grant.
    expect(h.keystone.calls.refresh).toBe(1)
    expect(h.published).toHaveLength(1)
    expect(h.published[0]?.bearer === h.keystone.issued[2]).toBe(true)
    expect((await readKsState(h.home, "rag-read"))?.needsPublish).toBeUndefined()
  })

  test("one tick: one publish per changed connection, connections independent", async () => {
    const h = await harness()
    await signedIn(h, "rag-read")
    await signedIn(h, "github")
    h.clock.now += 2_880_000
    const results = await refreshDue(h.deps)
    expect(results.map((r) => r.outcome).sort()).toEqual(["refreshed", "refreshed"])
    expect(h.published.map((p) => p.connection).sort()).toEqual(["github", "rag-read"])
    // Only the listed connections are refreshed when a list is given.
    h.clock.now += 2_880_000
    h.published.length = 0
    await refreshDue(h.deps, ["github"])
    expect(h.published.map((p) => p.connection)).toEqual(["github"])
  })
})

describe("two bridges, one lock", () => {
  test("never both refresh one connection; the rotated token survives", async () => {
    const h = await harness({ realLock: true })
    await signedIn(h)
    h.clock.now += 2_880_000
    const a = h.deps
    const b = h.peer("test-bridge-b")
    const results = await Promise.all([refreshDue(a), refreshDue(b), refreshDue(a), refreshDue(b)])
    expect(h.keystone.calls.refresh).toBe(1)
    expect(results.flat().filter((r) => r.outcome === "refreshed")).toHaveLength(1)
    expect(h.published).toHaveLength(1)
    const state = await readKsState(h.home, "rag-read")
    expect(state?.needsSignIn).toBeUndefined()
    expect(h.stores.get("rag-read")?.value === h.keystone.issued[3]).toBe(true)
    // The next cycle works from either bridge (the stored token is the live one, not a consumed one).
    h.clock.now += 2_880_000
    await refreshDue(b)
    expect(h.keystone.calls.refresh).toBe(2)
    expect((await readKsState(h.home, "rag-read"))?.needsSignIn).toBeUndefined()
  })
})

describe("secrets stay secret", () => {
  test("no token in the state file, the store directory listing, or any log line", async () => {
    const h = await harness()
    await signedIn(h)
    h.clock.now += 2_880_000
    await refreshDue(h.deps)
    h.keystone.fail.refresh = "invalid_grant"
    h.clock.now += 2_880_000
    await refreshDue(h.deps)
    const text = await hostText(h)
    expect(h.log.lines.length > 0).toBe(true)
    expect(h.keystone.issued.length >= 4).toBe(true)
    expect(h.keystone.issued.some((token) => text.includes(token))).toBe(false)
    expect(text.includes("test-code")).toBe(false)
  })

  test("status reports states, never a value", async () => {
    const h = await harness()
    await signedIn(h)
    const [s] = await keystoneAuthStatus(h.deps)
    expect(s?.connection).toBe("rag-read")
    expect(s?.state).toBe("signed_in")
    expect(s?.refreshTokenStored).toBe(true)
    const text = JSON.stringify(s)
    expect(h.keystone.issued.some((token) => text.includes(token))).toBe(false)
  })

  test("state file sits under <home>/keystone and the DPAPI store uses a Keystone-only entropy per connection", async () => {
    const h = await harness()
    expect(path.dirname(ksStateFile(h.home, "rag-read"))).toBe(path.join(h.home, "keystone"))
    expect(path.dirname(keystoneStoreFile(h.home, "rag-read"))).toBe(path.join(h.home, "keystone"))
    const scripts: string[] = []
    const store = keystoneDpapiStore(h.home, "rag-read", async (script) => {
      scripts.push(script)
      return "Y2lwaGVy"
    }, "win32")
    await store.write("test-value")
    expect(scripts[0]?.includes("opencode-delegate/keystone-refresh/v1/rag-read")).toBe(true)
    expect(scripts[0]?.includes("synapse-refresh")).toBe(false)
    // The secret goes to PowerShell on stdin, never in the script text.
    expect(scripts[0]?.includes("test-value")).toBe(false)
    expect(store.kind).toBe("dpapi-file")
  })
})
