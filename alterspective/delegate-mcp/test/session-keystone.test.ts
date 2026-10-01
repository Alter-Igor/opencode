// R4-01 per-session narrowing (soft, convenience only): oc_start_session {keystone} gets OpenCode
// permission rules that deny the other ks-* entries' tools and MCP resource reads; oc_send checks
// the session still has exactly those rules. The box-wide set (front) is the wall, not this.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { permissionBaseline } from "../src/guard/permissions.ts"
import { saveKeystoneSet } from "../src/shared/keystone.ts"
import { parseHostState } from "../src/supervisor/workspaces-state.ts"
import { sendTool } from "../src/tools/send.ts"
import { startSessionTool } from "../src/tools/sessions.ts"
import { BASE, SID, data, fakeContext, invoke, ours, remoteSession, type Fake } from "./tools-core-fixture.ts"

/** OpenCode's evaluation: the last rule whose permission and pattern both match (wildcards `*`). */
function decide(rules: Array<{ permission: string; pattern: string; action: string }>, permission: string, pattern = "*"): string | undefined {
  const match = (value: string, glob: string) => new RegExp(`^${glob.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value)
  return [...rules].reverse().find((r) => match(permission, r.permission) && match(pattern, r.pattern))?.action
}

describe("permissionBaseline narrowing", () => {
  test("without keystone the baseline is unchanged", () => {
    expect(permissionBaseline("standard", undefined)).toEqual(permissionBaseline("standard"))
  })

  test("standard: only the named connections' tools stay allowed; the others are denied, MCP resource reads too", () => {
    const rules = permissionBaseline("standard", ["rag-global"])
    expect(decide(rules, "ks-rag-global_search")).toBe("allow")
    expect(decide(rules, "ks-github_create_issue")).toBe("deny")
    expect(decide(rules, "ks-seqlogs_query")).toBe("deny")
    expect(decide(rules, "read", "mcp:ks-github:repo://x")).toBe("deny")
    expect(decide(rules, "read", "mcp:ks-rag-global:doc://x")).toBe("allow")
    // Other permissions are not touched.
    expect(decide(rules, "edit")).toBe("allow")
    expect(decide(rules, "read", "/sessions/s-1/README.md")).toBe("allow")
  })

  test("a name that is a prefix of another does not let the other through", () => {
    const rules = permissionBaseline("standard", ["git"])
    expect(decide(rules, "ks-git_x")).toBe("allow")
    expect(decide(rules, "ks-github_x")).toBe("deny")
  })

  test("readonly keeps asking for the named connections and denies the rest", () => {
    const rules = permissionBaseline("readonly", ["github"])
    expect(decide(rules, "ks-github_create_issue")).toBe("ask")
    expect(decide(rules, "ks-rag-global_search")).toBe("deny")
  })

  test("an empty list denies every Keystone tool", () => {
    const rules = permissionBaseline("standard", [])
    expect(decide(rules, "ks-rag-global_search")).toBe("deny")
  })

  test("invalid ids are refused", () => {
    expect(() => permissionBaseline("standard", ["../x"])).toThrow()
  })
})

const canCreate = (f: Fake) => f.api.on("POST /session", { status: 200, data: { id: SID } })

describe("oc_start_session {keystone}", () => {
  test("sends the narrowed rules, records the list on the host, and reports it", async () => {
    const f = fakeContext()
    canCreate(f)
    const result = await invoke(startSessionTool, { directory: "C:\\GitHub\\demo", keystone: ["rag-global"] }, f.ctx)
    expect(result.isError).toBeUndefined()
    const create = f.api.find("POST", "/session")?.body as { permission: unknown }
    expect(create.permission).toEqual(permissionBaseline("standard", ["rag-global"]))
    const key = f.opened[0]?.[1] ?? ""
    expect(f.states.get(key)).toMatchObject({ sessionID: SID, keystone: ["rag-global"] })
    expect(f.ctx.sessions.get(SID)).toMatchObject({ keystone: ["rag-global"] })
    expect(data(result)).toMatchObject({ keystone: ["rag-global"] })
  })

  test("refuses a connection that is not in the box-wide set, before anything is opened", async () => {
    const f = fakeContext()
    canCreate(f)
    const result = await invoke(startSessionTool, { directory: "C:\\GitHub\\demo", keystone: ["rag-global", "m365"] }, f.ctx)
    expect(data(result)).toMatchObject({ code: "invalid_input" })
    expect(String(data(result).message)).toContain("m365")
    expect(f.opened).toEqual([])
  })

  test("the subset check uses the saved box-wide set", async () => {
    const f = fakeContext()
    f.ctx.config.home = mkdtempSync(path.join(os.tmpdir(), "ocd-session-ks-"))
    saveKeystoneSet(f.ctx.config.home, ["seqlogs"])
    canCreate(f)
    expect(data(await invoke(startSessionTool, { directory: "C:\\GitHub\\demo", keystone: ["rag-global"] }, f.ctx))).toMatchObject({ code: "invalid_input" })
    expect((await invoke(startSessionTool, { directory: "C:\\GitHub\\demo", keystone: ["seqlogs"] }, f.ctx)).isError).toBeUndefined()
  })

  test("without keystone the plain baseline is sent and nothing is recorded", async () => {
    const f = fakeContext()
    canCreate(f)
    await invoke(startSessionTool, { directory: "C:\\GitHub\\demo" }, f.ctx)
    expect((f.api.find("POST", "/session")?.body as { permission: unknown }).permission).toEqual(permissionBaseline("standard"))
    expect(f.states.get(f.opened[0]?.[1] ?? "")?.keystone).toBeUndefined()
  })
})

describe("oc_send on a narrowed session", () => {
  function ready(f: Fake, permission: unknown) {
    ours(f, { keystone: ["rag-global"] })
    f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f, { permission }) })
    f.api.on("GET /mcp", { status: 200, data: { "ks-rag-global": { status: "connected" } } })
    f.api.on(`POST /session/${SID}/prompt_async`, { status: 204 })
  }

  test("accepted while the session has exactly its narrowed rules", async () => {
    const f = fakeContext()
    ready(f, permissionBaseline("standard", ["rag-global"]))
    const result = await invoke(sendTool, { sessionID: SID, message: "go" }, f.ctx)
    expect(result.isError).toBeUndefined()
  })

  test("refused when the narrowing was dropped from the session's rules (policy_violation)", async () => {
    const f = fakeContext()
    ready(f, permissionBaseline("standard"))
    const result = await invoke(sendTool, { sessionID: SID, message: "go" }, f.ctx)
    expect(data(result)).toMatchObject({ code: "policy_violation" })
  })
})

describe("host record", () => {
  const raw = (keystone: unknown) => JSON.stringify({ hostRepo: "C:\\GitHub\\demo", base: BASE, sessionID: SID, supervisor: "supervisor:x", profile: "standard", keystone })

  test("a valid narrowing list is kept; a damaged one is dropped (the next send then fails closed)", () => {
    expect(parseHostState(raw(["rag-global"]), "s-0000000001")?.keystone).toEqual(["rag-global"])
    for (const bad of [["../x"], "rag-global", [1], Array.from({ length: 21 }, (_, i) => `c${i}`)])
      expect(parseHostState(raw(bad), "s-0000000001")?.keystone).toBeUndefined()
  })
})
