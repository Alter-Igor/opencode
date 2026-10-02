// #67 step 4, review cycle 1 (written before the fixes, RED first):
// M1 a box another bridge holds is reconnected (oc_login uses a running box; every bridge's tick and
//    oc_doctor reconnect signed-in entries on the box they can reach);
// M2 a failed entry with a valid host token is reconnected without a new consent;
// LOW single-flight connect, flag-on ensureKsAuthConf before compose up, a flag mismatch named,
//    publish_failed wording.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { ensureEntryConnected, reconnectTick } from "../src/keystone-auth/host-wiring.ts"
import type { KsStatus } from "../src/keystone-auth/index.ts"
import type { Level, Logger } from "../src/shared/log.ts"
import { doctorTool } from "../src/tools/doctor.ts"
import { loginTool } from "../src/tools/login.ts"
import { FakeApi, LIVE_OK, data, fakeContext, invoke, text } from "./tools-core-fixture.ts"
import { deps, fail, fakeDocker, home, supervisor, useSupervisorFixture, writeOwner, type Box, type Call } from "./supervisor-lifecycle-fixture.ts"

useSupervisorFixture()

const silent: Logger = { log: (_l: Level) => {} }
const state = (connection: string, s: KsStatus["state"]): KsStatus => ({ connection, state: s, expiresAt: "2026-10-02T01:00:00.000Z", refreshTokenStored: s === "signed_in", pendingSave: false, clientRegistered: true, store: "dpapi" })

function hostKs(states: KsStatus[], outcome: "signed_in" | "publish_failed" = "signed_in") {
  const signed: string[] = []
  return {
    signed,
    service: {
      signIn: async (id: string) => {
        signed.push(id)
        return { connection: id, outcome, expiresAt: Date.parse("2026-10-02T01:00:00Z") }
      },
      status: async (ids?: readonly string[]) => states.filter((s) => ids === undefined || ids.includes(s.connection)),
    },
  }
}

describe("M1: a box this bridge does not hold yet", () => {
  test("oc_login uses the RUNNING box (another bridge's) to connect, and never says not running", async () => {
    const f = fakeContext({ boxHeld: false })
    const ks = hostKs([state("github", "needs_sign_in")])
    f.ctx.keystone = ks.service
    f.api.on("GET /mcp", { status: 200, data: { "ks-github": { status: "failed" } } }).on("POST /mcp/ks-github/connect", { status: 200, data: true })
    const result = await invoke(loginTool, { server: "ks-github" }, f.ctx)
    // Cycle 2: attach to the running target only; box()/ensure() could START a box that stopped meanwhile.
    expect(f.started.count).toBe(0)
    expect(f.api.find("POST", "/mcp/ks-github/connect")).toBeDefined()
    expect(text(result)).not.toContain("not running")
  })

  test("cycle 2: a connect that throws after a good sign-in reports box unknown, not a failed tool", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.keystone = hostKs([state("github", "needs_sign_in"), state("rag-read", "signed_in")]).service
    f.ctx.supervisorService = { ...f.ctx.supervisorService, status: async () => { throw new Error("docker gone") } }
    const one = await invoke(loginTool, { server: "ks-github" }, f.ctx)
    expect(data(one)).toMatchObject({ result: "connected", outcome: "signed_in", box: "unknown" })
    const all = await invoke(loginTool, {}, f.ctx)
    expect(data(all)).toMatchObject({ results: [{ server: "ks-github", result: "connected" }] })
  })

  test("oc_login does not start a stopped sandbox just to connect", async () => {
    const f = fakeContext({ boxHeld: false })
    f.status.value = { state: "stopped" }
    f.ctx.keystone = hostKs([state("github", "needs_sign_in")]).service
    const result = await invoke(loginTool, { server: "ks-github" }, f.ctx)
    expect(f.started.count).toBe(0)
    expect(data(result)).toMatchObject({ box: "not_running" })
  })

  test("reconnectTick: connects signed-in entries on the held box; nothing without a box", async () => {
    const api = new FakeApi([]).on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "failed" } } }).on("POST /mcp/ks-rag-read/connect", { status: 200, data: true })
    const status = async () => [state("rag-read", "signed_in")]
    expect(await reconnectTick(() => undefined, status, () => ["rag-read"], silent)).toEqual({})
    await reconnectTick(() => api, status, () => ["rag-read"], silent)
    expect(api.find("POST", "/mcp/ks-rag-read/connect")).toBeDefined()
  })

  test("oc_doctor reconnects signed-in entries on the box it reads before reporting them", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.keystone = hostKs([state("rag-read", "signed_in"), state("github", "signed_in"), state("seqlogs", "signed_in")]).service
    f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "failed" }, "ks-github": { status: "connected" }, "ks-seqlogs": { status: "connected" } } }).on("POST /mcp/ks-rag-read/connect", { status: 200, data: true })
    f.live.value = { ...LIVE_OK, signIns: { ...LIVE_OK.signIns, names: [] } }
    await invoke(doctorTool, {}, f.ctx)
    expect(f.api.find("POST", "/mcp/ks-rag-read/connect")).toBeDefined()
    expect(f.api.find("POST", "/mcp/ks-github/connect")).toBeUndefined()
  })
})

describe("M2: reconnect without a new consent", () => {
  test("oc_login {server} with a valid host token reconnects only; force:true signs in again", async () => {
    const f = fakeContext()
    const ks = hostKs([state("github", "signed_in")])
    f.ctx.keystone = ks.service
    f.api.on("GET /mcp", { status: 200, data: { "ks-github": { status: "failed" } } }).on("POST /mcp/ks-github/connect", { status: 200, data: true })
    const result = await invoke(loginTool, { server: "ks-github" }, f.ctx)
    expect(ks.signed).toEqual([])
    expect(f.api.find("POST", "/mcp/ks-github/connect")).toBeDefined()
    expect(data(result)).toMatchObject({ server: "ks-github", outcome: "reconnected", host: true })
    await invoke(loginTool, { server: "ks-github", force: true }, f.ctx)
    expect(ks.signed).toEqual(["github"])
  })

  test("oc_login with no server also reconnects signed-in connections whose entry failed", async () => {
    const f = fakeContext()
    const ks = hostKs([state("rag-read", "signed_in"), state("github", "signed_in"), state("seqlogs", "signed_in")])
    f.ctx.keystone = ks.service
    f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "failed" }, "ks-github": { status: "connected" }, "ks-seqlogs": { status: "connected" } } }).on("POST /mcp/ks-rag-read/connect", { status: 200, data: true })
    const result = await invoke(loginTool, {}, f.ctx)
    expect(ks.signed).toEqual([])
    expect(f.api.find("POST", "/mcp/ks-rag-read/connect")).toBeDefined()
    expect(data(result)).toMatchObject({ reconnected: { "ks-rag-read": "failed" } })
  })

  test("the doctor hint says oc_login reconnects with host-held tokens", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.keystone = hostKs([state("rag-read", "signed_in"), state("github", "signed_in"), state("seqlogs", "signed_in")]).service
    f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "connected" }, "ks-github": { status: "failed" }, "ks-seqlogs": { status: "connected" } } })
    expect(text(await invoke(doctorTool, {}, f.ctx))).toContain("reconnects entries whose host token is valid")
  })

  test("publish_failed says the bridge retries by itself", async () => {
    const f = fakeContext()
    f.ctx.keystone = hostKs([state("github", "needs_sign_in")], "publish_failed").service
    expect(text(await invoke(loginTool, { server: "ks-github" }, f.ctx))).toContain("the bridge retries automatically")
  })
})

describe("LOW: single-flight connect", () => {
  test("two concurrent connects of one entry on one box send one POST", async () => {
    const api = new FakeApi([]).on("GET /mcp", { status: 200, data: { "ks-github": { status: "failed" } } }).on("POST /mcp/ks-github/connect", { status: 200, data: true })
    await Promise.all([ensureEntryConnected(api, "ks-github", silent), ensureEntryConnected(api, "ks-github", silent)])
    expect(api.calls.filter((c) => c.method === "POST").length).toBe(1)
  })
})

describe("LOW: supervisor with the flag on", () => {
  async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const before = process.env.OCD_KEYSTONE_HOST_AUTH
    if (value === undefined) delete process.env.OCD_KEYSTONE_HOST_AUTH
    else process.env.OCD_KEYSTONE_HOST_AUTH = value
    try {
      return await fn()
    } finally {
      if (before === undefined) delete process.env.OCD_KEYSTONE_HOST_AUTH
      else process.env.OCD_KEYSTONE_HOST_AUTH = before
    }
  }

  test("a start writes one empty ks-auth-<id>.conf per chosen connection before compose up", async () => {
    await writeOwner()
    const box: Box = { running: false, labels: {}, env: [] }
    const calls: Call[] = []
    let seenAtUp: boolean[] = []
    const exec = fakeDocker(box, calls, {
      up: () => {
        seenAtUp = ["rag-read", "github", "seqlogs"].map((id) => existsSync(path.join(home, "front", `ks-auth-${id}.conf`)))
        return undefined
      },
    })
    await withFlag("1", () => supervisor(deps(exec)).ensure())
    expect(seenAtUp).toEqual([true, true, true])
    expect(readFileSync(path.join(home, "front", "ks-auth-github.conf"), "utf8")).toContain('set $ks_auth "";')
  })

  for (const flag of [undefined, "1"]) {
    test(`cycle 2: no Keystone service chosen, flag ${flag ?? "off"}: the running box is reused (no false flag mismatch)`, async () => {
      await writeOwner()
      const box: Box = { running: false, labels: {}, env: [] }
      const calls: Call[] = []
      const exec = fakeDocker(box, calls)
      const none = (b: string) => deps(exec, { bridgeId: b, config: { ...deps(exec).config, keystoneConnections: [] } })
      await withFlag(flag, () => supervisor(none("bridge-a")).ensure())
      const ups = calls.filter((c) => c.argv.includes("up")).length
      await withFlag(flag, () => supervisor(none("bridge-b")).ensure())
      expect(calls.filter((c) => c.argv.includes("up")).length).toBe(ups)
    })
  }

  test("a box started with the other flag value is refused with an error that names OCD_KEYSTONE_HOST_AUTH", async () => {
    await writeOwner()
    const box: Box = { running: false, labels: {}, env: [] }
    const calls: Call[] = []
    const exec = fakeDocker(box, calls)
    await withFlag(undefined, () => supervisor(deps(exec)).ensure())
    const error = await withFlag("1", () => fail(supervisor(deps(exec, { bridgeId: "bridge-b" })).ensure()))
    expect(error.code).toBe("profile_changed")
    expect(`${error.message} ${error.action}`).toContain("OCD_KEYSTONE_HOST_AUTH")
  })
})
