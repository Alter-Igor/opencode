// R4-01 — the box-wide Keystone set: ids, the MCP allow policy, the profile entries, persistence
// in the bridge home, and oc_server_restart {keystone} through supervisor.replace.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { currentKeystone, defaultConfig, effectiveConfig, mcpAllowPolicy } from "../src/shared/config.ts"
import { DelegateError } from "../src/shared/errors.ts"
import { CONNECTION_ID, DEFAULT_KEYSTONE, connectionPathPattern, idOfEntry, keystoneIds, readKeystoneSet, saveKeystoneSet } from "../src/shared/keystone.ts"
import { nodeLeaseFs } from "../src/supervisor/leases.ts"
import { mcpEntries } from "../src/supervisor/profile.ts"
import { deps, fail, fakeDocker, home, leaseDir, supervisor, writeOwner, type Call, useSupervisorFixture } from "./supervisor-lifecycle-fixture.ts"

useSupervisorFixture()

const ORIGIN = "https://identity.alterspective.com.au"
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), "ocd-ks-"))
const policyRe = (ids: string[]) => {
  const policy = JSON.parse(mcpAllowPolicy({ keystoneOrigin: ORIGIN, keystoneConnections: ids })) as { remote: Array<{ origin: string; path: string }> }
  return { policy, re: policy.remote[0] ? new RegExp(policy.remote[0].path) : undefined }
}

describe("connection ids", () => {
  test("the default set is rag-global, github, seqlogs, and the config uses it unless OPENCODE_DELEGATE_KEYSTONE is set", () => {
    expect([...DEFAULT_KEYSTONE]).toEqual(["rag-global", "github", "seqlogs"])
    expect(defaultConfig({}).keystoneConnections).toEqual(["rag-global", "github", "seqlogs"])
    expect(defaultConfig({ OPENCODE_DELEGATE_KEYSTONE: "rag-global, github" }).keystoneConnections).toEqual(["rag-global", "github"])
  })

  test("ids must match ^[a-z0-9][a-z0-9-]{0,62}$; duplicates collapse; order is kept", () => {
    expect(CONNECTION_ID.source).toBe("^[a-z0-9][a-z0-9-]{0,62}$")
    expect(keystoneIds(["github", "rag-global", "github"])).toEqual(["github", "rag-global"])
    for (const bad of ["", "-x", "Rag", "rag_global", "a/b", "..", "a.b", "dynamic|x", "x".repeat(64), "a b", "a%2Fb"])
      expect(() => keystoneIds([bad])).toThrow(DelegateError)
    expect(() => keystoneIds([1])).toThrow(DelegateError)
    expect(() => keystoneIds(Array.from({ length: 21 }, (_, i) => `c${i}`))).toThrow(DelegateError)
  })

  test("entry names map to ids only for ks-<valid id>", () => {
    expect(idOfEntry("ks-rag-global")).toBe("rag-global")
    for (const bad of ["rag-global", "ks-", "ks--x", "ks-Rag", "KS-rag", "ks-a_b"]) expect(idOfEntry(bad)).toBeUndefined()
  })
})

describe("OPENCODE_MCP_ALLOW policy (R4-01)", () => {
  test("only the chosen /mcp/c/<id> paths: no dynamic, no other id, no prefix or suffix", () => {
    const { policy, re } = policyRe(["rag-global", "github", "seqlogs"])
    expect(policy.remote).toHaveLength(1)
    expect(policy.remote[0]!.origin).toBe(ORIGIN)
    expect(policy.remote[0]!.path).toBe("^/mcp/c/(rag-global|github|seqlogs)$")
    for (const ok of ["/mcp/c/rag-global", "/mcp/c/github", "/mcp/c/seqlogs"]) expect(re!.test(ok)).toBe(true)
    for (const bad of ["/mcp/dynamic", "/api/mcp", "/mcp/c/m365", "/mcp/c/github2", "/mcp/c/xgithub", "/mcp/c/github/", "/mcp/c/github/x", "/x/mcp/c/github", "/mcp/c/", "/mcp/c/rag-global|dynamic"])
      expect({ bad, ok: re!.test(bad) }).toEqual({ bad, ok: false })
  })

  test("the default config's policy has no dynamic", () => {
    expect(mcpAllowPolicy(defaultConfig({}))).not.toContain("dynamic")
  })

  test("ids are regex-escaped in the pattern (a future id rule cannot widen it)", () => {
    expect(connectionPathPattern(["a1-b"])).toBe("^/mcp/c/(a1-b)$")
    expect(() => connectionPathPattern(["a.b"])).toThrow(DelegateError)
  })

  test("no connections: an empty rule list, which the fork patch reads as refuse-all", () => {
    expect(policyRe([]).policy).toEqual({ remote: [] })
  })
})

describe("profile entries (R4-01)", () => {
  test("one ks-<id> → /mcp/c/<id> per chosen id and no ks-delegate / dynamic entry", () => {
    expect(mcpEntries({ keystoneOrigin: ORIGIN, keystoneConnections: ["rag-global", "github", "seqlogs"], boxEnv: [] })).toEqual({
      "ks-rag-global": { type: "remote", url: `${ORIGIN}/mcp/c/rag-global` },
      "ks-github": { type: "remote", url: `${ORIGIN}/mcp/c/github` },
      "ks-seqlogs": { type: "remote", url: `${ORIGIN}/mcp/c/seqlogs` },
    })
    expect(mcpEntries({ keystoneOrigin: ORIGIN, keystoneConnections: [], boxEnv: [] })).toEqual({})
  })
})

describe("saved set in the bridge home", () => {
  test("missing file: the config default; saved file wins; damaged file fails closed (profile_invalid)", () => {
    const dir = tmpHome()
    expect(readKeystoneSet(dir, ["rag-global"])).toEqual({ connections: ["rag-global"], source: "default" })
    expect(saveKeystoneSet(dir, ["github", "github", "seqlogs"])).toEqual(["github", "seqlogs"])
    expect(readKeystoneSet(dir, ["rag-global"])).toEqual({ connections: ["github", "seqlogs"], source: "saved" })
    expect(currentKeystone({ home: dir, keystoneConnections: ["rag-global"] }).connections).toEqual(["github", "seqlogs"])
    expect(effectiveConfig({ ...defaultConfig({}), home: dir }).keystoneConnections).toEqual(["github", "seqlogs"])
    for (const text of ["not json", "{}", '{"connections":"github"}', '{"connections":["../x"]}', "null"]) {
      writeFileSync(path.join(dir, "keystone.json"), text)
      const error = (() => {
        try {
          readKeystoneSet(dir, [])
        } catch (e) {
          return e as DelegateError
        }
      })()
      expect({ text, code: error?.code }).toEqual({ text, code: "profile_invalid" })
    }
  })

  test("an invalid id is refused before anything is written", () => {
    const dir = tmpHome()
    expect(() => saveKeystoneSet(dir, ["ok", "Bad"])).toThrow(DelegateError)
    expect(existsSync(path.join(dir, "keystone.json"))).toBe(false)
  })
})

const composeCalls = (calls: Call[], sub: "up" | "down") => calls.filter((c) => c.argv.includes("compose") && c.argv.includes(sub))
const allowIn = (call: Call | undefined) => JSON.parse(call?.env?.OPENCODE_MCP_ALLOW ?? "{}") as { remote: Array<{ path: string }> }

describe("oc_server_restart {keystone} → supervisor.replace (R4-01)", () => {
  test("changes the set: saved, policy and front config regenerated, the box restarted; a new bridge reuses it", async () => {
    await writeOwner()
    const calls: Call[] = []
    const state = { running: false, labels: {}, env: [] }
    const result = await supervisor(deps(fakeDocker(state, calls))).replace({ force: false, keystone: ["rag-global"] })
    expect(result.keystone).toEqual(["rag-global"])
    expect(JSON.parse(readFileSync(path.join(home, "keystone.json"), "utf8"))).toEqual({ connections: ["rag-global"] })
    const up = composeCalls(calls, "up")[0]
    expect(allowIn(up).remote[0]!.path).toBe("^/mcp/c/(rag-global)$")
    const servers = readFileSync(path.join(home, "front", "servers.conf"), "utf8")
    expect(servers).toContain("location = /mcp/c/rag-global {")
    expect(servers).not.toContain("/mcp/c/github")
    expect(up?.env?.OCD_FRONT_DIR).toBe(path.join(home, "front"))
    expect(up?.env?.OCD_FRONT_HASH).toMatch(/^[0-9a-f]{64}$/)
    const profile = JSON.parse(readFileSync(path.join(home, "profile", "opencode", "opencode.json"), "utf8")) as { mcp: Record<string, unknown> }
    expect(Object.keys(profile.mcp)).toEqual(["ks-rag-global"])
    // Another bridge (same home) reads the saved set: same profile and front hash, so it reuses the box.
    const later: Call[] = []
    expect((await supervisor(deps(fakeDocker(state, later), { bridgeId: "bridge-b" })).ensure()).baseUrl).toBe(result.target.baseUrl)
    expect(composeCalls(later, "up")).toHaveLength(0)
  })

  test("refused while another bridge holds the box (no force): nothing saved, nothing stopped", async () => {
    await writeOwner()
    const calls: Call[] = []
    const state = { running: false, labels: {}, env: [] }
    await supervisor(deps(fakeDocker(state, calls))).replace({ force: false })
    await nodeLeaseFs.write(path.join(leaseDir(), "bridge-b"), JSON.stringify({ pid: process.pid, bridgeId: "bridge-b" }) + "\n")
    const refused = await fail(supervisor(deps(fakeDocker(state, calls), { bridgeId: "bridge-c" })).replace({ force: false, keystone: ["github"] }))
    expect(refused.code).toBe("profile_changed")
    expect(existsSync(path.join(home, "keystone.json"))).toBe(false)
    expect(composeCalls(calls, "down")).toHaveLength(1)
  })

  test("an invalid id is invalid_input before anything is stopped or saved", async () => {
    await writeOwner()
    const calls: Call[] = []
    const error = await fail(supervisor(deps(fakeDocker({ running: true, labels: {}, env: [] }, calls))).replace({ force: true, keystone: ["GitHub"] }))
    expect(error.code).toBe("invalid_input")
    expect(composeCalls(calls, "down")).toHaveLength(0)
    expect(existsSync(path.join(home, "keystone.json"))).toBe(false)
  })

  test("a box started with the default set is not reused once another set is saved (profile_changed)", async () => {
    await writeOwner()
    const state = { running: false, labels: {}, env: [] }
    await supervisor(deps(fakeDocker(state, []))).ensure()
    saveKeystoneSet(home, ["seqlogs"])
    const error = await fail(supervisor(deps(fakeDocker(state, []), { bridgeId: "bridge-b" })).ensure())
    expect(error.code).toBe("profile_changed")
  })
})
