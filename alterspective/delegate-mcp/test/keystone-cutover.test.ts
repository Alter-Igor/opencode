// #67 step 4 (WS-C): host-held Keystone tokens wired behind OCD_KEYSTONE_HOST_AUTH. Written before
// the wiring (RED first): profile + guard say oauth:false, the publisher writes front's include and
// reloads under the lock it is handed (never taking it again), connects the box entry, oc_login signs
// in on the host, the box store is pruned to {}, and oc_doctor reports keystoneAuth. With the flag
// OFF everything stays as it was (the existing suites cover that; a few rows here pin it too).
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { validateEntries } from "../src/guard/entries.ts"
import { connectSignedIn, createKsPublisher, ensureEntryConnected } from "../src/keystone-auth/host-wiring.ts"
import type { KsStatus } from "../src/keystone-auth/index.ts"
import { defaultConfig } from "../src/shared/config.ts"
import type { McpEntry } from "../src/shared/contracts.ts"
import { DelegateError } from "../src/shared/errors.ts"
import type { Level, Logger } from "../src/shared/log.ts"
import { authArgs } from "../src/supervisor/auth-store.ts"
import type { Exec } from "../src/supervisor/docker.ts"
import { nodeLeaseFs } from "../src/supervisor/leases.ts"
import { keptSignIns, pruneSignIns, verifyLive } from "../src/supervisor/live.ts"
import { login } from "../src/supervisor/login.ts"
import { nodeProcessProbe, ownStartTime } from "../src/supervisor/process.ts"
import { mcpEntries } from "../src/supervisor/profile.ts"
import type { Run } from "../src/supervisor/run.ts"
import { withStartLock } from "../src/supervisor/start-lock.ts"
import { ksAuthConfPath } from "../src/synapse/auth-conf.ts"
import { reloadFront } from "../src/synapse/token-manager.ts"
import { doctorTool } from "../src/tools/doctor.ts"
import { loginTool } from "../src/tools/login.ts"
import { FakeApi, LIVE_OK, data, fakeContext, invoke, text } from "./tools-core-fixture.ts"

const ORIGIN = "https://identity.alterspective.com.au"
const CHOSEN = ["rag-read", "github", "seqlogs"]
// A syntactically valid compact JWT used only as a marker: it must never show up in any output.
const TOKEN = `eyJhbGciOiJSUzI1NiJ9.${"c2VjcmV0LXRva2VuLW1hcmtlcg".repeat(3)}.c2lnbmF0dXJlLXZhbHVl`

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  return { lines, log: (level: Level, component: string, msg: string, fields = {}) => void lines.push(JSON.stringify({ level, component, msg, ...fields })) }
}

const home = () => mkdtempSync(path.join(os.tmpdir(), "ocd-ks-cutover-"))

describe("profile and guard with host-held tokens", () => {
  const config = { keystoneOrigin: ORIGIN, keystoneConnections: CHOSEN, boxEnv: [] }

  test("flag on: every ks-<id> entry is {type: remote, url, oauth: false}", () => {
    const entries = mcpEntries(config, true) as Record<string, McpEntry>
    expect(Object.keys(entries)).toEqual(CHOSEN.map((id) => `ks-${id}`))
    for (const id of CHOSEN) expect(entries[`ks-${id}`]).toEqual({ type: "remote", url: `${ORIGIN}/mcp/c/${id}`, oauth: false })
  })

  test("flag off: entries are unchanged (no oauth key)", () => {
    const entries = mcpEntries(config, false) as Record<string, McpEntry>
    for (const id of CHOSEN) expect(entries[`ks-${id}`]).toEqual({ type: "remote", url: `${ORIGIN}/mcp/c/${id}` })
  })

  const entry = (oauth?: unknown): McpEntry => ({ type: "remote", url: `${ORIGIN}/mcp/c/github`, ...(oauth === undefined ? {} : { oauth }) })

  test("flag on: the guard requires exactly oauth:false", () => {
    expect(validateEntries({ "ks-github": entry(false) }, ORIGIN, CHOSEN, true)).toEqual({ ok: true })
    for (const bad of [undefined, null, true, {}, { scope: "mcp:connection" }, "false", 0]) {
      const verdict = validateEntries({ "ks-github": entry(bad) }, ORIGIN, CHOSEN, true)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toContain("oauth must be exactly false")
    }
  })

  test("flag on: every other rule still applies", () => {
    expect(validateEntries({ "ks-github": { type: "remote", url: `${ORIGIN}/mcp/dynamic`, oauth: false } }, ORIGIN, CHOSEN, true).ok).toBe(false)
    expect(validateEntries({ "ks-m365": { type: "remote", url: `${ORIGIN}/mcp/c/m365`, oauth: false } }, ORIGIN, CHOSEN, true).ok).toBe(false)
    expect(validateEntries({ "ks-github": { ...entry(false), headers: {} } }, ORIGIN, CHOSEN, true).ok).toBe(false)
  })

  test("flag off: oauth:false is still refused, an absent oauth still accepted", () => {
    expect(validateEntries({ "ks-github": entry(false) }, ORIGIN, CHOSEN, false).ok).toBe(false)
    expect(validateEntries({ "ks-github": entry() }, ORIGIN, CHOSEN, false)).toEqual({ ok: true })
  })
})

/** A fake docker exec for front-reload: exit `code` for the reload, `running` for docker inspect. */
function frontExec(code: number, calls: string[][] = []): Exec {
  return async (argv) => {
    calls.push(argv)
    if (argv.includes("inspect")) return { code: 0, stdout: "true\n", stderr: "" }
    return { code, stdout: "", stderr: code === 0 ? "" : "front-reload: config test failed\n" }
  }
}

describe("the Keystone publisher (front include + reload under the held lock)", () => {
  test("writes ks-auth-<id>.conf, reloads front, and connects the box entry after a bearer", async () => {
    const dir = home()
    const calls: string[][] = []
    const connected: string[] = []
    const log = recordingLogger()
    const publish = createKsPublisher({
      frontDir: path.join(dir, "front"),
      reload: () => reloadFront({ exec: frontExec(0, calls), frontContainer: "ocd-front", home: dir, now: Date.now, log }),
      connect: async (entry) => void connected.push(entry),
      log,
    })
    await publish("rag-read", TOKEN)
    expect(readFileSync(ksAuthConfPath(path.join(dir, "front"), "rag-read"), "utf8")).toContain(`"Bearer ${TOKEN}"`)
    expect(calls.some((argv) => argv.includes("/usr/local/bin/front-reload"))).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(connected).toEqual(["ks-rag-read"])
    expect(log.lines.join("\n")).not.toContain(TOKEN)
    expect(log.lines.join("\n")).toContain("keystone credential published")
  })

  test("an empty credential is written and reloaded, but nothing is connected", async () => {
    const dir = home()
    const connected: string[] = []
    const publish = createKsPublisher({ frontDir: dir, reload: async () => "reloaded", connect: async (entry) => void connected.push(entry), log: recordingLogger() })
    await publish("github", undefined)
    expect(readFileSync(ksAuthConfPath(dir, "github"), "utf8")).toContain('set $ks_auth "";')
    await new Promise((r) => setTimeout(r, 10))
    expect(connected).toEqual([])
  })

  test("front not running counts as published (front loads the file when it starts)", async () => {
    const publish = createKsPublisher({ frontDir: home(), reload: async () => "front_not_running", connect: async () => {}, log: recordingLogger() })
    await publish("github", TOKEN)
  })

  test("a refused reload throws (the manager retries) and says why without the token", async () => {
    for (const reload of ["config_invalid", "config_changed", "unverified", "busy"] as const) {
      const publish = createKsPublisher({ frontDir: home(), reload: async () => reload, connect: async () => {}, log: recordingLogger() })
      const error = await publish("github", TOKEN).then(() => undefined, (e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain(reload)
      expect(String(error)).not.toContain(TOKEN)
    }
  })

  test("a failed connect is logged, never thrown into the manager", async () => {
    const log = recordingLogger()
    const publish = createKsPublisher({ frontDir: home(), reload: async () => "reloaded", connect: async () => { throw new Error("box down") }, log })
    await publish("github", TOKEN)
    await new Promise((r) => setTimeout(r, 10))
    expect(log.lines.join("\n")).toContain("keystone entry connect failed")
  })

  test("runs to completion INSIDE the real (non re-entrant) shared lock: no second acquire, no deadlock", async () => {
    const dir = home()
    const lockFile = path.join(dir, "synapse", "refresh.lock")
    const self = { pid: process.pid, startedAt: await ownStartTime(nodeProcessProbe) }
    const options = { now: Date.now, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), probe: nodeProcessProbe, self, waitMs: 400, staleMs: 400 }
    const publish = createKsPublisher({
      frontDir: path.join(dir, "front"),
      reload: () => reloadFront({ exec: frontExec(0), frontContainer: "ocd-front", home: dir, now: Date.now, log: recordingLogger() }),
      connect: async () => {},
      log: recordingLogger(),
    })
    const began = Date.now()
    await withStartLock(nodeLeaseFs, lockFile, () => publish("rag-read", TOKEN), options)
    // A nested acquire would have waited the full 400 ms and then thrown.
    expect(Date.now() - began).toBeLessThan(400)
  })
})

describe("ensureEntryConnected (OpenCode does not reconnect by itself with oauth:false)", () => {
  test("a connected entry is left alone", async () => {
    const api = new FakeApi([]).on("GET /mcp", { status: 200, data: { "ks-github": { status: "connected" } } })
    expect(await ensureEntryConnected(api, "ks-github", recordingLogger())).toBe("connected")
    expect(api.find("POST", "/mcp/ks-github/connect")).toBeUndefined()
  })

  test("a failed entry gets POST /mcp/<entry>/connect, then its new status", async () => {
    const api = new FakeApi([]).on("GET /mcp", { status: 200, data: { "ks-github": { status: "failed", error: "401" } } }).on("POST /mcp/ks-github/connect", { status: 200, data: true })
    const result = await ensureEntryConnected(api, "ks-github", recordingLogger())
    expect(api.find("POST", "/mcp/ks-github/connect")).toMatchObject({ directory: "/sessions" })
    expect(result).toBe("failed")
  })

  test("connectSignedIn: on a new box, connects only entries whose host token is signed in", async () => {
    const api = new FakeApi([]).on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "failed" }, "ks-github": { status: "failed" } } }).on("POST /mcp/ks-rag-read/connect", { status: 200, data: true })
    const state = (connection: string, s: KsStatus["state"]): KsStatus => ({ connection, state: s, refreshTokenStored: true, pendingSave: false, clientRegistered: true, store: "dpapi" })
    const result = await connectSignedIn(async () => [state("rag-read", "signed_in"), state("github", "needs_sign_in")], ["rag-read", "github"], api, recordingLogger())
    expect(Object.keys(result)).toEqual(["ks-rag-read"])
    expect(api.find("POST", "/mcp/ks-github/connect")).toBeUndefined()
    expect(await connectSignedIn(async () => { throw new Error("store") }, ["rag-read"], api, recordingLogger())).toEqual({})
  })

  test("refuses a name that is not a ks-<id> entry", async () => {
    await expect(ensureEntryConnected(new FakeApi([]), "../x", recordingLogger())).rejects.toBeInstanceOf(DelegateError)
  })
})

describe("the box sign-in store with host-held tokens", () => {
  test("keptSignIns: flag on keeps nothing; flag off keeps the chosen ks-<id> names", () => {
    expect(keptSignIns(CHOSEN, true)).toEqual([])
    expect(keptSignIns(CHOSEN, false)).toEqual(CHOSEN.map((id) => `ks-${id}`))
  })

  function fakeRun(dir: string, stdout: string, calls: string[][]): Run {
    const exec: Exec = async (argv) => {
      calls.push(argv)
      return { code: 0, stdout, stderr: "" }
    }
    return { deps: { exec, config: { ...defaultConfig({}), home: dir, keystoneConnections: CHOSEN }, now: () => Date.parse("2026-10-02T00:00:00Z") }, container: "ocd", note: () => {} } as unknown as Run
  }

  test("flag on: prune keeps [] and records the removed client ids (never a token)", async () => {
    const dir = home()
    const calls: string[][] = []
    const out = JSON.stringify({ names: [], removed: [{ name: "ks-rag-read", clientId: "dcr-1234abcd", serverUrl: `${ORIGIN}/mcp/c/rag-read`, hadRefresh: true }] })
    await pruneSignIns(fakeRun(dir, out, calls), { config: { ...defaultConfig({}), keystoneConnections: CHOSEN } }, true)
    expect(calls[0]).toEqual(["docker", "exec", "ocd", ...authArgs("prune", [])])
    const recorded = readFileSync(path.join(dir, "auth-pruned.json"), "utf8")
    expect(recorded).toContain("dcr-1234abcd")
    expect(recorded).not.toContain("refreshToken")
  })

  test("flag on: verifyLive fails while the box store has any entry, and says so", async () => {
    const dir = home()
    const run = fakeRun(dir, JSON.stringify({ names: ["ks-rag-read"], removed: [] }), [])
    const live = await verifyLive(run, true)
    expect(live.signIns.ok).toBe(false)
    expect(live.signIns.stale).toEqual(["ks-rag-read"])
    expect(live.problems.join(" ")).toContain("host-held Keystone tokens are on")
  })
})

describe("oc_login with host-held tokens", () => {
  function hostKeystone(statuses: KsStatus[] = []) {
    const signed: string[] = []
    return {
      signed,
      service: {
        signIn: async (id: string) => {
          signed.push(id)
          return { connection: id, outcome: "signed_in" as const, expiresAt: Date.parse("2026-10-02T01:00:00Z") }
        },
        status: async () => statuses,
      },
    }
  }

  test("signs in on the HOST, never through the box flow, and connects the box entry", async () => {
    const f = fakeContext()
    const ks = hostKeystone()
    let boxLogins = 0
    f.ctx.supervisorService = { ...f.ctx.supervisorService, login: async () => (boxLogins++, "connected") }
    f.ctx.keystone = ks.service
    f.api.on("GET /mcp", { status: 200, data: { "ks-github": { status: "failed" } } }).on("POST /mcp/ks-github/connect", { status: 200, data: true })
    const result = await invoke(loginTool, { server: "ks-github" }, f.ctx)
    expect(ks.signed).toEqual(["github"])
    expect(boxLogins).toBe(0)
    expect(f.api.find("POST", "/mcp/ks-github/auth")).toBeUndefined()
    expect(f.api.find("POST", "/mcp/ks-github/connect")).toBeDefined()
    expect(data(result)).toMatchObject({ server: "ks-github", result: "connected", outcome: "signed_in", host: true })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  test("with no server: signs in only connections the host store says need it", async () => {
    const f = fakeContext({ boxHeld: false })
    // Review M1: a running box is now reused to connect entries; a stopped one is never started.
    f.status.value = { state: "stopped" }
    const status = (connection: string, state: KsStatus["state"]): KsStatus => ({ connection, state, refreshTokenStored: state === "signed_in", pendingSave: false, clientRegistered: true, store: "dpapi" })
    const ks = hostKeystone([status("rag-read", "signed_in"), status("github", "needs_sign_in"), status("seqlogs", "signed_out")])
    f.ctx.keystone = ks.service
    const result = await invoke(loginTool, {}, f.ctx)
    expect(ks.signed).toEqual(["github", "seqlogs"])
    expect(f.started.count).toBe(0)
    expect(data(result)).toMatchObject({ host: true, results: [{ server: "ks-github", result: "connected" }, { server: "ks-seqlogs", result: "connected" }] })
  })

  test("the box sign-in relay refuses to run while host-held tokens are on", async () => {
    const api = new FakeApi([])
    await expect(login(api, "ks-github", { authOrigin: ORIGIN, hostAuth: true })).rejects.toMatchObject({ code: "policy_violation" })
    expect(api.calls).toEqual([])
  })
})

describe("runtime wiring", () => {
  const version = { version: "0.1.4-dev+test", package: "0.1.4", sha: "test", dirty: false, built: null }

  test("flag on: the tool context gets the host Keystone service and the runtime a renewal loop", async () => {
    const { createRuntime } = await import("../src/runtime.ts")
    const config = { ...defaultConfig({}), home: home() }
    // The flag is read from process.env, the same source the supervisor and front generator use.
    const before = process.env.OCD_KEYSTONE_HOST_AUTH
    process.env.OCD_KEYSTONE_HOST_AUTH = "1"
    let runtime
    try {
      runtime = await createRuntime({ env: { OPENCODE_DELEGATE_NAME: "ks-test" }, config, log: recordingLogger(), version })
    } finally {
      if (before === undefined) delete process.env.OCD_KEYSTONE_HOST_AUTH
      else process.env.OCD_KEYSTONE_HOST_AUTH = before
    }
    expect(runtime.ctx.keystone).toBeDefined()
    expect(runtime.keystone).toBeDefined()
  })

  test("flag off: no host Keystone service, no loop (the box signs in itself, as before)", async () => {
    const { createRuntime } = await import("../src/runtime.ts")
    const config = { ...defaultConfig({}), home: home() }
    const runtime = await createRuntime({ env: { OPENCODE_DELEGATE_NAME: "ks-test" }, config, log: recordingLogger(), version })
    expect(runtime.ctx.keystone).toBeUndefined()
    expect(runtime.keystone).toBeUndefined()
  })
})

describe("oc_doctor keystoneAuth", () => {
  const CHOSEN_MCP = { "ks-rag-read": { status: "connected" }, "ks-github": { status: "connected" }, "ks-seqlogs": { status: "connected" } }
  const signedIn = (connection: string): KsStatus => ({ connection, state: "signed_in", expiresAt: "2026-10-02T01:00:00.000Z", refreshTokenStored: true, pendingSave: false, clientRegistered: true, credential: "published", store: "dpapi" })
  const front = (ids: string[]) => ids.map((id) => ({ id, shape: true, token: true }))

  function setup(options: { statuses?: KsStatus[]; frontIds?: string[]; names?: string[] } = {}) {
    const f = fakeContext({ boxHeld: false })
    f.api.on("GET /mcp", { status: 200, data: CHOSEN_MCP })
    f.ctx.keystone = { signIn: async () => { throw new Error("not used") }, status: async () => options.statuses ?? CHOSEN.map(signedIn) }
    f.live.value = { ...LIVE_OK, signIns: { ...LIVE_OK.signIns, names: options.names ?? [], ok: (options.names ?? []).length === 0 }, front: { ...LIVE_OK.front, keystone: front(options.frontIds ?? CHOSEN) } }
    return f
  }

  test("flag off: keystoneAuth says disabled and verified is unchanged", async () => {
    const f = fakeContext({ boxHeld: false })
    f.api.on("GET /mcp", { status: 200, data: CHOSEN_MCP })
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result)).toMatchObject({ verified: true, keystoneAuth: { enabled: false } })
  })

  test("flag on, all signed in and published, box store empty: verified, with per-connection fields", async () => {
    const result = await invoke(doctorTool, {}, setup().ctx)
    expect(data(result)).toMatchObject({
      verified: true,
      keystoneAuth: {
        enabled: true,
        ok: true,
        boxStoreEmpty: true,
        missingInFront: [],
        extraInFront: [],
        connections: [{ connection: "rag-read", signedIn: true, needsSignIn: false, expiresAt: "2026-10-02T01:00:00.000Z", published: { shape: true, token: true } }, {}, {}],
      },
    })
    expect(text(result)).toContain("Keystone tokens (host)")
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  test("flag on: a box store with any entry is NOT verified, and the client ids to revoke are listed", async () => {
    const f = setup({ names: ["ks-rag-read"] })
    f.live.value = { ...f.live.value, ok: false, problems: ["x"], signIns: { ...f.live.value.signIns, stale: ["ks-rag-read"], removedBefore: [{ name: "ks-github", clientId: "dcr-feedbeef", hadRefresh: true, at: "2026-10-02T00:00:00.000Z" }] } }
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result)).toMatchObject({ verified: false, keystoneAuth: { ok: false, boxStoreEmpty: false } })
    expect(text(result)).toContain("dcr-feedbeef")
  })

  test("flag on: front listing other ids than the chosen ones is a mismatch", async () => {
    const result = await invoke(doctorTool, {}, setup({ frontIds: ["rag-read", "github", "m365"] }).ctx)
    expect(data(result)).toMatchObject({ verified: false, keystoneAuth: { ok: false, missingInFront: ["seqlogs"], extraInFront: ["m365"] } })
    expect(text(result)).toContain("m365")
  })

  test("flag on: a connection that needs sign-in is NOT verified and says oc_login", async () => {
    const statuses = [signedIn("rag-read"), { ...signedIn("github"), state: "needs_sign_in" as const, refreshTokenStored: false }, signedIn("seqlogs")]
    const result = await invoke(doctorTool, {}, setup({ statuses }).ctx)
    expect(data(result)).toMatchObject({ verified: false, keystoneAuth: { ok: false, connections: [{}, { connection: "github", needsSignIn: true, signedIn: false }, {}] } })
    expect(text(result)).toContain('oc_login {server: "ks-github"}')
  })
})
