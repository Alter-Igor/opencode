// Wave 3 review fixes (W3C-01 / W3A-01 / W3A-05 / W3A-17): session ownership comes from the
// bridge's host records, never from the box's session metadata; restarted bridges find their
// sessions again through those records.
import { describe, expect, test } from "bun:test"
import { listSessionsTool, statusTool } from "../src/tools/sessions.ts"
import { sendTool } from "../src/tools/send.ts"
import { BASE, OTHER_SID, SID, data, fakeContext, invoke, okCmd, ours, remoteSession, seedState, text, type Fake } from "./tools-core-fixture.ts"

const LIST = "GET /experimental/session?roots=true&limit=200"
const EVIL_REPO = "C:\\GitHub\\evil"
const EVIL_BASE = "e".repeat(40)

/** A session made in the box by anyone, claiming this bridge in its metadata. */
function forged(f: Fake, overrides: Record<string, unknown> = {}) {
  const metadata = { supervisor: f.ctx.supervisor, sessionKey: "s-forged0001", hostRepo: EVIL_REPO, base: EVIL_BASE, profile: "standard", ...overrides }
  return { id: OTHER_SID, directory: `/sessions/${String(metadata.sessionKey)}`, title: "forged", metadata, permission: f.ctx.guard.permissionBaseline("standard") }
}

function box(f: Fake) {
  f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "connected" } } })
  f.api.on(`POST /session/${OTHER_SID}/prompt_async`, { status: 204 })
  f.api.on(`POST /session/${SID}/prompt_async`, { status: 204 })
  f.setHost((argv) => (argv.includes("ls-tree") ? okCmd(`100644 blob ${"c".repeat(40)}\tAGENTS.md\u0000`) : okCmd("rules")))
}

describe("forged session metadata is never trusted (W3C-01)", () => {
  test("right supervisor, other repo/base/profile, no host record: not adopted, nothing sent, no instruction read", async () => {
    const f = fakeContext()
    box(f)
    f.api.on(`GET /session/${OTHER_SID}`, { status: 200, data: forged(f) })
    const result = await invoke(sendTool, { sessionID: OTHER_SID, message: "x" }, f.ctx)
    expect(data(result).code).toBe("not_found")
    expect(f.ctx.sessions.has(OTHER_SID)).toBe(false)
    expect(f.api.find("POST", `/session/${OTHER_SID}/prompt_async`)).toBeUndefined()
    expect(f.hostCmds).toEqual([])
    expect(f.hub.tracked).toEqual([])
  })

  test("metadata pointing at a real host record of ours, but a different session id: not adopted", async () => {
    const f = fakeContext()
    box(f)
    seedState(f) // s-0000000001 → SID
    f.api.on(`GET /session/${OTHER_SID}`, { status: 200, data: forged(f, { sessionKey: "s-0000000001" }) })
    const result = await invoke(sendTool, { sessionID: OTHER_SID, message: "x" }, f.ctx)
    expect(data(result).code).toBe("not_found")
    expect(f.api.find("POST", `/session/${OTHER_SID}/prompt_async`)).toBeUndefined()
  })

  test("a host record of ANOTHER bridge on this host is not ours", async () => {
    const f = fakeContext()
    box(f)
    seedState(f, { supervisor: "supervisor:someone-else" })
    f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f) })
    expect(data(await invoke(sendTool, { sessionID: SID, message: "x" }, f.ctx)).code).toBe("not_found")
  })

  test("adopted fields come from the host record: repo, base and instructions are the owner's, not the metadata's", async () => {
    const f = fakeContext()
    box(f)
    seedState(f)
    f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f, { metadata: { supervisor: f.ctx.supervisor, sessionKey: "s-0000000001", hostRepo: EVIL_REPO, base: EVIL_BASE, profile: "standard", model: "evil/model" } }) })
    const result = await invoke(sendTool, { sessionID: SID, message: "x" }, f.ctx)
    expect(result.isError).toBeUndefined()
    expect(f.ctx.sessions.get(SID)).toMatchObject({ hostRepo: "C:\\GitHub\\demo", base: BASE, profile: "standard" })
    expect(f.ctx.sessions.get(SID)?.model).toBeUndefined()
    expect(f.hostCmds.every((c) => c[2] === "C:\\GitHub\\demo" && !c.join(" ").includes(EVIL_BASE))).toBe(true)
  })

  test("a readonly session cannot be upgraded by metadata that says standard", async () => {
    const f = fakeContext()
    box(f)
    seedState(f, { profile: "readonly" })
    // The box claims standard and carries the standard baseline: the record stays readonly, so the H3 re-read refuses.
    f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f, { metadata: { supervisor: f.ctx.supervisor, sessionKey: "s-0000000001", profile: "standard" } }) })
    const result = await invoke(sendTool, { sessionID: SID, message: "x" }, f.ctx)
    expect(data(result).code).toBe("policy_violation")
    expect(f.ctx.sessions.get(SID)?.profile).toBe("readonly")
    expect(f.api.find("POST", `/session/${SID}/prompt_async`)).toBeUndefined()
  })

  test("oc_list_sessions: a forged session claiming this bridge is not `mine`", async () => {
    const f = fakeContext()
    ours(f)
    f.api.on(LIST, { status: 200, data: [remoteSession(f), forged(f)] })
    const mine = data(await invoke(listSessionsTool, {}, f.ctx)).sessions as Array<Record<string, unknown>>
    expect(mine.map((s) => s.sessionID)).toEqual([SID])
    const all = data(await invoke(listSessionsTool, { all: true }, f.ctx)).sessions as Array<Record<string, unknown>>
    expect(all.find((s) => s.sessionID === OTHER_SID)).toMatchObject({ mine: false, metadataSupervisor: f.ctx.supervisor })
  })
})

describe("after a bridge restart with the same name (W3A-05)", () => {
  test("oc_status with no arguments finds and adopts the sessions named by host records", async () => {
    const f = fakeContext({ boxHeld: false })
    seedState(f)
    f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f) })
    const result = await invoke(statusTool, {}, f.ctx)
    expect((data(result).sessions as Array<Record<string, unknown>>).map((s) => [s.sessionID, s.state])).toEqual([[SID, "idle"]])
    expect(f.ctx.sessions.has(SID)).toBe(true)
    expect(f.started.count).toBe(1)
  })

  test("a host-record session the sandbox lost is not_found in oc_status", async () => {
    const f = fakeContext()
    seedState(f)
    const result = await invoke(statusTool, {}, f.ctx)
    expect(data(result).sessions).toMatchObject([{ sessionID: SID, state: "not_found" }])
  })

  test("oc_list_sessions: host-record rows are adopted, or shown not_tracked with a note", async () => {
    const f = fakeContext()
    seedState(f)
    f.api.on(LIST, { status: 200, data: [remoteSession(f)] })
    f.api.on(`GET /session/${SID}`, { status: 500 })
    const rows = data(await invoke(listSessionsTool, {}, f.ctx)).sessions as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({ sessionID: SID, mine: true, state: "not_tracked" })
    expect(String(rows[0]?.note)).toContain("host record")
    f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f) })
    const again = data(await invoke(listSessionsTool, {}, f.ctx)).sessions as Array<Record<string, unknown>>
    expect(again[0]).toMatchObject({ sessionID: SID, state: "idle", branch: "delegate/s-0000000001" })
  })

  test("missingFromServer only after a 404 re-read; a session beyond the page is not reported missing", async () => {
    const f = fakeContext()
    ours(f)
    seedState(f, { sessionKey: "s-0000000002", sessionID: OTHER_SID })
    f.api.on(LIST, { status: 200, data: [] })
    f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f) })
    const result = await invoke(listSessionsTool, {}, f.ctx)
    expect(data(result).missingFromServer).toEqual([OTHER_SID])
    expect(data(result).presenceUnknown).toBeUndefined()
  })
})

describe("box fields outside `untrusted` are validated (W3A-06 / W3C-03)", () => {
  test("a bad directory goes under untrustedDirectory; a non-number `updated` is dropped", async () => {
    const f = fakeContext()
    f.api.on(LIST, { status: 200, data: [{ id: SID, directory: "/etc/../x\u001b[2J", title: "t", time: { updated: "soon" } }] })
    const rows = data(await invoke(listSessionsTool, { all: true }, f.ctx)).sessions as Array<Record<string, unknown>>
    expect(rows[0]?.directory).toBeUndefined()
    expect(rows[0]?.untrustedDirectory).toMatchObject({ text: "/etc/../x[2J" })
    expect(rows[0]?.updated).toBeUndefined()
    expect(text(await invoke(listSessionsTool, { all: true }, f.ctx)).split("\n")[0]).not.toContain("/etc")
  })
})

describe("gone and subagent sessions (W3A-17)", () => {
  test("a 404 on one of our own sessions says the session is gone", async () => {
    const f = fakeContext()
    ours(f)
    const result = await invoke(sendTool, { sessionID: SID, message: "x" }, f.ctx)
    expect(data(result).code).toBe("not_found")
    expect(String(data(result).message)).toContain("is gone")
  })

  test("a subagent id points at its parent session", async () => {
    const f = fakeContext()
    f.api.on(`GET /session/${OTHER_SID}`, { status: 200, data: { id: OTHER_SID, directory: "/sessions/s-0000000001", parentID: SID } })
    const result = await invoke(sendTool, { sessionID: OTHER_SID, message: "x" }, f.ctx)
    expect(data(result).code).toBe("not_found")
    expect(String(data(result).action)).toContain(`parent session ${SID}`)
  })
})
