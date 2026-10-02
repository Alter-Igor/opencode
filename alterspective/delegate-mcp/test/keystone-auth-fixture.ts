// #67 step 1: a fake Keystone for the host token manager tests. No network: it answers the MCP SDK's
// discovery, dynamic registration and token calls in memory, and it rotates refresh tokens STRICTLY
// (a used refresh token is refused with invalid_grant), as the step 0 spike observed on the real one.
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { memoryStore } from "../src/synapse/secret-store.ts"
import type { SecretStore } from "../src/synapse/secret-store.ts"
import type { FetchLike, KeystoneAuthDeps } from "../src/keystone-auth/manager.ts"
import { nodeLeaseFs } from "../src/supervisor/leases.ts"
import { nodeProcessProbe } from "../src/supervisor/process.ts"
import { withStartLock } from "../src/supervisor/start-lock.ts"
import { synapseLockFile } from "../src/synapse/lock.ts"
import type { Logger } from "../src/shared/log.ts"
import { jwt } from "./synapse-fixture.ts"

export const ORIGIN = "https://identity.example.test"
export const SCOPE = "mcp:connection"

export type FakeKeystone = {
  fetch: FetchLike
  calls: { prm: number; metadata: number; register: number; code: number; refresh: number }
  /** Every token value this fake ever issued: none may appear in a log line or a state file. */
  issued: string[]
  /** Bodies of registration requests, and token-request parameters (for scope/resource checks). */
  registrations: Record<string, unknown>[]
  tokenRequests: URLSearchParams[]
  /** Valid refresh tokens; a used one is removed (strict rotation). */
  valid: Set<string>
  /** Make the next token calls fail: "down" throws like a network error, an OAuth code answers 400. */
  fail: { refresh?: "down" | "invalid_grant" | "invalid_client" }
  /** Overrides for the authorization server metadata (e.g. another origin). */
  metadata: Record<string, unknown>
  /** Overrides for the protected-resource metadata. */
  resource: Record<string, unknown>
  issue(): { access: string; refresh: string }
}

export function fakeKeystone(): FakeKeystone {
  let counter = 0
  const k: FakeKeystone = {
    calls: { prm: 0, metadata: 0, register: 0, code: 0, refresh: 0 },
    issued: [],
    registrations: [],
    tokenRequests: [],
    valid: new Set(),
    fail: {},
    metadata: {},
    resource: {},
    issue() {
      counter++
      const access = jwt({ sub: "test-owner", aud: `${ORIGIN}/mcp/c/rag-read`, n: counter })
      const refresh = `test-refresh-${counter}-${"r".repeat(12)}`
      k.issued.push(access, refresh)
      k.valid.add(refresh)
      return { access, refresh }
    },
    fetch: async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        k.calls.prm++
        const id = url.pathname.split("/").at(-1)
        return Response.json({ resource: `${ORIGIN}/mcp/c/${id}`, authorization_servers: [ORIGIN], scopes_supported: [SCOPE], ...k.resource })
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        k.calls.metadata++
        return Response.json({
          issuer: ORIGIN,
          authorization_endpoint: `${ORIGIN}/api/oauth/authorize`,
          token_endpoint: `${ORIGIN}/api/oauth/token`,
          registration_endpoint: `${ORIGIN}/api/oauth/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          ...k.metadata,
        })
      }
      if (url.pathname.startsWith("/.well-known/")) return new Response("not found", { status: 404 })
      if (url.pathname === "/api/oauth/register") {
        k.calls.register++
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        k.registrations.push(body)
        return Response.json({ ...body, client_id: `test-client-${k.calls.register}` }, { status: 201 })
      }
      if (url.pathname === "/api/oauth/token") {
        const params = new URLSearchParams(String(init?.body))
        k.tokenRequests.push(params)
        if (params.get("grant_type") === "authorization_code") {
          k.calls.code++
          if (params.get("code") !== "test-code") return Response.json({ error: "invalid_grant" }, { status: 400 })
        } else {
          k.calls.refresh++
          if (k.fail.refresh === "down") throw new TypeError("fetch failed")
          if (k.fail.refresh) return Response.json({ error: k.fail.refresh }, { status: 400 })
          const presented = params.get("refresh_token") ?? ""
          // Strict rotation: the presented token is consumed whether or not the caller keeps the reply.
          if (!k.valid.delete(presented)) return Response.json({ error: "invalid_grant" }, { status: 400 })
        }
        const t = k.issue()
        return Response.json({ access_token: t.access, refresh_token: t.refresh, token_type: "Bearer", expires_in: 3600, scope: SCOPE })
      }
      return new Response("unexpected", { status: 500 })
    },
  }
  return k
}

export type Published = { connection: string; bearer: string | undefined; storeAtPublish: string | undefined }

const homes: string[] = []
export async function cleanupHomes(): Promise<void> {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
}

/** A captured logger: every line as text, to prove no token is logged. */
export function captureLog(): Logger & { lines: string[] } {
  const lines: string[] = []
  return { lines, log: (level, component, msg, fields) => void lines.push(JSON.stringify({ level, component, msg, ...fields })) }
}

export type Harness = {
  home: string
  keystone: FakeKeystone
  stores: Map<string, SecretStore & { value: string | undefined }>
  published: Published[]
  clock: { now: number }
  log: Logger & { lines: string[] }
  deps: KeystoneAuthDeps
  /** A second bridge on the same home: own memory, same stores, clock, publish sink and lock file. */
  peer(id: string): KeystoneAuthDeps
}

/**
 * One bridge home. `realLock` uses the real start-lock on the SAME lock file as the Synapse refresh
 * (one lock for every write of front's files), so two bridges really exclude each other.
 */
export async function harness(options: { realLock?: boolean } = {}): Promise<Harness> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocd-ks-auth-"))
  homes.push(home)
  const keystone = fakeKeystone()
  const stores = new Map<string, SecretStore & { value: string | undefined }>()
  const published: Published[] = []
  const clock = { now: 1_000_000 }
  const log = captureLog()
  const storeFor = (id: string) => {
    let store = stores.get(id)
    if (!store) stores.set(id, (store = memoryStore()))
    return store
  }
  const lockFile = synapseLockFile(home)
  const lock: KeystoneAuthDeps["lock"] = options.realLock
    ? (fn) => withStartLock(nodeLeaseFs, lockFile, fn, { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), probe: nodeProcessProbe, self: { pid: process.pid, startedAt: 1 }, waitMs: 10_000 })
    : (fn) => fn()
  const make = (id: string): KeystoneAuthDeps => ({
    home,
    origin: ORIGIN,
    store: storeFor,
    memory: { id, held: new Map() },
    fetch: keystone.fetch,
    lock,
    publish: async (connection, bearer) => void published.push({ connection, bearer, storeAtPublish: stores.get(connection)?.value }),
    now: () => clock.now,
    refreshFraction: 0.8,
    opener: () => {},
    loginPort: 0,
    loginTimeoutMs: 5_000,
    log,
  })
  return { home, keystone, stores, published, clock, log, deps: make("test-bridge-a"), peer: make }
}
