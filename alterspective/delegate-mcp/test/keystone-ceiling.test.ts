// R5-03 / R5-04: the owner's ceiling on the Keystone set (launch env, never a tool call), the
// high-risk id list, and R5-01: every start, reuse and set change removes stored sign-ins of
// entries outside the chosen set from the box.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { currentKeystone, defaultConfig } from "../src/shared/config.ts"
import { DelegateError } from "../src/shared/errors.ts"
import { CEILING_ENV, ceilingOf, enforceCeiling, highRiskIds } from "../src/shared/keystone-policy.ts"
import { restartTool } from "../src/tools/restart.ts"
import { keystoneReport } from "../src/tools/keystone-report.ts"
import { deps, fail, fakeDocker, home, recorder, supervisor, writeOwner, type Call, useSupervisorFixture } from "./supervisor-lifecycle-fixture.ts"

useSupervisorFixture()

const isExec = (call: Call) => call.argv[1] === "exec"
const composeCalls = (calls: Call[], sub: "up" | "down") => calls.filter((c) => c.argv.includes("compose") && c.argv.includes(sub))
const keepOf = (call: Call | undefined) => JSON.parse(call?.argv.at(-2) ?? "null") as string[] | null

describe("owner ceiling (R5-03)", () => {
  test("read from the launch env; without it the ceiling is the default set", () => {
    expect(defaultConfig({}).keystoneAllowed).toBeUndefined()
    expect(ceilingOf(defaultConfig({}))).toEqual(["rag-global", "github", "seqlogs"])
    expect(ceilingOf(defaultConfig({ [CEILING_ENV]: "rag-global, m365 ,github" }))).toEqual(["rag-global", "m365", "github"])
    expect(() => ceilingOf(defaultConfig({ [CEILING_ENV]: "rag-global,Bad" }))).toThrow(DelegateError)
  })

  test("ids outside the ceiling are policy_violation, and the message tells the owner what to do", () => {
    const error = (() => {
      try {
        enforceCeiling(["github", "m365"], defaultConfig({}))
      } catch (e) {
        return e as DelegateError
      }
    })()
    expect(error?.code).toBe("policy_violation")
    expect(error?.message).toContain("m365")
    expect(error?.action).toContain(CEILING_ENV)
    expect(error?.action).toContain("restart the MCP client")
  })

  test("oc_server_restart {keystone:[m365]} is refused before anything stops; nothing is saved", async () => {
    await writeOwner()
    const calls: Call[] = []
    const state = { running: true, labels: {}, env: [] }
    const error = await fail(supervisor(deps(fakeDocker(state, calls))).replace({ force: true, keystone: ["m365"] }))
    expect(error.code).toBe("policy_violation")
    expect(composeCalls(calls, "down")).toEqual([])
    expect(existsSync(path.join(home, "keystone.json"))).toBe(false)
  })

  test("the owner's ceiling lets the same call through", async () => {
    await writeOwner()
    const calls: Call[] = []
    const d = deps(fakeDocker({ running: false, labels: {}, env: [] }, calls))
    const config = { ...d.config, keystoneAllowed: ["rag-global", "m365"] }
    const result = await supervisor({ ...d, config }).replace({ force: false, keystone: ["m365"] })
    expect(result.keystone).toEqual(["m365"])
  })

  test("a saved set outside the ceiling fails closed (the box is never started with it)", async () => {
    await writeOwner()
    writeFileSync(path.join(home, "keystone.json"), JSON.stringify({ connections: ["rag-global", "m365"] }))
    expect(() => currentKeystone(defaultConfig({ OPENCODE_DELEGATE_HOME: home }))).toThrow(DelegateError)
    const calls: Call[] = []
    const error = await fail(supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, calls))).ensure())
    expect(error.code).toBe("policy_violation")
    expect(composeCalls(calls, "up")).toEqual([])
  })

  test("the tool says one connection can relay to other services and names the ceiling", () => {
    expect(restartTool.description).toContain(CEILING_ENV)
    expect(restartTool.description).toContain("relay")
  })
})

describe("high-risk ids (R5-04)", () => {
  test("prefix match on the known list", () => {
    expect(highRiskIds(["rag-global", "github", "seqlogs"])).toEqual([])
    expect(highRiskIds(["cas", "vault-global", "keystone-admin-global", "m365", "monday-prod", "hubspot-mcp-prod", "stripe", "xero", "sharedo-mb-uat", "github"])).toEqual(["cas", "vault-global", "keystone-admin-global", "m365", "monday-prod", "hubspot-mcp-prod", "stripe", "xero", "sharedo-mb-uat"])
  })

  test("the Keystone report shows the ceiling and warns for high-risk ids in the ceiling or the set", () => {
    const plain = keystoneReport(defaultConfig({ OPENCODE_DELEGATE_HOME: home }))
    expect(plain).toMatchObject({ ceiling: ["rag-global", "github", "seqlogs"], highRisk: [] })
    const wide = keystoneReport({ ...defaultConfig({ OPENCODE_DELEGATE_HOME: home }), keystoneAllowed: ["rag-global", "cas", "vault-global"] })
    expect(wide).toMatchObject({ highRisk: ["cas", "vault-global"], warnings: [expect.stringContaining("cas")] })
  })
})

describe("stored sign-ins outside the set are removed (R5-01)", () => {
  const pruneReply = (removed: unknown[] = []) => ({ code: 0, stdout: JSON.stringify({ names: ["ks-rag-global"], removed }), stderr: "" })

  test("a start prunes with keep = the chosen entries, records names only, and logs no token", async () => {
    await writeOwner()
    const calls: Call[] = []
    const log = recorder()
    const removed = [{ name: "ks-delegate", clientId: "dcr-0226f1c0", server: "/mcp/dynamic", hadRefresh: true }]
    const exec = fakeDocker({ running: false, labels: {}, env: [] }, calls, { exec: () => pruneReply(removed) })
    await supervisor({ ...deps(exec), log }).ensure()
    const prune = calls.filter(isExec).find((c) => c.argv.includes("prune"))
    expect(prune?.argv.slice(0, 3)).toEqual(["docker", "exec", "opencode-delegate"])
    expect(keepOf(prune)).toEqual(["ks-rag-global", "ks-github", "ks-seqlogs"])
    const record = JSON.parse(readFileSync(path.join(home, "auth-pruned.json"), "utf8")) as { removed: Array<{ name: string }> }
    expect(record.removed.map((r) => r.name)).toEqual(["ks-delegate"])
    const line = log.lines.find((l) => l.msg.includes("removed stored sign-ins"))
    expect(line?.fields).toMatchObject({ names: "ks-delegate", count: 1 })
  })

  test("a reuse prunes too, and a set change prunes with the new set", async () => {
    await writeOwner()
    const calls: Call[] = []
    const state = { running: false, labels: {}, env: [] }
    const exec = fakeDocker(state, calls, { exec: () => pruneReply() })
    await supervisor(deps(exec)).ensure()
    await supervisor({ ...deps(exec), bridgeId: "bridge-b" }).ensure()
    expect(calls.filter((c) => isExec(c) && c.argv.includes("prune"))).toHaveLength(2)
    await supervisor({ ...deps(exec), bridgeId: "bridge-c" }).replace({ force: true, keystone: ["github"] })
    expect(keepOf(calls.filter((c) => isExec(c) && c.argv.includes("prune")).at(-1))).toEqual(["ks-github"])
  })

  test("a prune that fails makes ensure fail closed (policy_unverified)", async () => {
    await writeOwner()
    const exec = fakeDocker({ running: false, labels: {}, env: [] }, [], { exec: () => ({ code: 1, stdout: "", stderr: "lock busy" }) })
    const error = await fail(supervisor(deps(exec)).ensure())
    expect(error.code).toBe("policy_unverified")
  })
})
