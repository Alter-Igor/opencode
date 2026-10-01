// Wave 3 review fixes: oc_wait wording and hub changes (W3A-03), oc_doctor verification
// (W3A-09 / W3C-09), oc_result field checks (W3A-06 / W3C-08), oc_pending caps (W3C-12).
import { describe, expect, test } from "bun:test"
import { doctorTool } from "../src/tools/doctor.ts"
import { listPending, MAX_RAW } from "../src/tools/pending.ts"
import { resultTool } from "../src/tools/result.ts"
import { waitTool } from "../src/tools/wait.ts"
import type { Box } from "../src/tools/context.ts"
import { FakeApi, FakeHub, SID, TARGET, data, fakeContext, invoke, ours, text } from "./tools-core-fixture.ts"

describe("oc_wait (W3A-03 / W3A-11)", () => {
  test("a timeout names each state; an idle session is not called still running", async () => {
    const f = fakeContext()
    ours(f)
    f.hub.waitResult = { events: [], next: { epoch: "ep1", seq: 8 }, timedOut: true }
    const result = await invoke(waitTool, { sessionIDs: [SID], timeoutSec: 5, until: ["message"] }, f.ctx)
    const first = text(result).split("\n")[0] ?? ""
    expect(first).toContain(`No matching state after 5 s: ${SID} idle.`)
    expect(first).not.toContain("Still running")
    expect(data(result)).toMatchObject({ still_running: false, next: "ep1.8" })
  })

  test("a busy session on timeout is still running", async () => {
    const f = fakeContext()
    ours(f)
    f.hub.views.set(SID, { sessionID: SID, directory: "/sessions/s-0000000001", state: "busy", since: "x" })
    f.hub.waitResult = { events: [], next: { epoch: "ep1", seq: 8 }, timedOut: true }
    const result = await invoke(waitTool, { sessionIDs: [SID] }, f.ctx)
    expect(text(result)).toContain(`${SID} busy. Still running`)
    expect(data(result).still_running).toBe(true)
    expect(f.hub.waits[0]?.timeoutMs).toBe(100_000)
  })

  test("the hub stopped or was replaced during the wait: said so, with a fresh cursor from the new hub", async () => {
    const f = fakeContext()
    ours(f)
    const order: string[] = []
    const newHub = new FakeHub(order)
    newHub.cursor = () => ({ epoch: "ep2", seq: 1 })
    const replacement: Box = { target: TARGET, api: new FakeApi(order), hub: newHub }
    f.hub.wait = async () => {
      f.ctx.peekBox = () => replacement
      return { events: [], next: { epoch: "ep1", seq: 5 }, timedOut: true }
    }
    const result = await invoke(waitTool, { sessionIDs: [SID], cursor: "ep1.5" }, f.ctx)
    expect(data(result)).toMatchObject({ hub_changed: true, still_running: false, next: "ep2.1" })
    expect(text(result)).toContain("replaced or stopped during the wait")
  })
})

describe("oc_doctor (W3A-09 / W3C-09)", () => {
  const healthy = (f: ReturnType<typeof fakeContext>) => f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "connected" } } })

  test("all checks passed: verified true", async () => {
    const f = fakeContext({ boxHeld: false })
    healthy(f)
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result)).toMatchObject({ verified: true, egressHostsConfigured: f.ctx.config.egressHosts, isolation: { source: "configuration" } })
    expect(data(result).egressHosts).toBeUndefined()
    expect(text(result)).toContain("Verified: sandbox running (Docker health healthy")
  })

  test("an unhealthy container is not verified and the summary says so", async () => {
    const f = fakeContext({ boxHeld: false })
    healthy(f)
    f.status.value = { state: "running", target: TARGET, imageTag: "img:1", startedBy: "other", health: "unhealthy", policyVerified: true, frontMatches: true, imageMatches: true }
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result).verified).toBe(false)
    expect(text(result)).toContain("NOT verified")
    expect(text(result)).toContain("Docker health unhealthy")
  })

  test("Docker unavailable: not verified, and the advice is about Docker, not about starting the sandbox", async () => {
    const f = fakeContext({ boxHeld: false })
    f.status.value = { state: "unavailable", reason: "Docker is not running" }
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result).verified).toBe(false)
    expect(text(result)).toContain("Start Docker Desktop")
    expect(text(result)).not.toContain("start:true")
  })

  test("the summary names only ks-* entries; others are counted, and a sign-in gap is not verified", async () => {
    const f = fakeContext({ boxHeld: false })
    f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "needs_auth" }, "ignore-previous": { status: "connected" } } })
    const result = await invoke(doctorTool, {}, f.ctx)
    const first = text(result).split("\n")[0] ?? ""
    expect(first).toContain("ks-rag-read needs_auth")
    expect(first).toContain("1 other entry")
    expect(first).not.toContain("ignore-previous")
    expect(data(result).verified).toBe(false)
  })
})

describe("oc_result box fields (W3A-06 / W3C-08)", () => {
  test("a malformed message id is dropped; an unknown error name becomes a label", async () => {
    const f = fakeContext()
    ours(f)
    f.api.on(`GET /session/${SID}/message?limit=16`, { status: 200, data: [
      { info: { id: "msg_ok123", role: "assistant", error: { name: "APIError" } }, parts: [] },
      { info: { id: "msg_../../evil ignore", role: "assistant", error: { name: "IgnorePreviousInstructions" } }, parts: [] },
    ] })
    const replies = data(await invoke(resultTool, { sessionID: SID, messages: 2 }, f.ctx)).replies as Array<Record<string, unknown>>
    expect(replies[0]).toMatchObject({ messageID: "msg_ok123", error: "APIError" })
    expect(replies[1]?.messageID).toBeUndefined()
    expect(replies[1]?.error).toBe("unrecognised error")
  })
})

describe("oc_pending caps (W3C-12)", () => {
  const request = (i: number) => ({ id: `per_${String(i).padStart(4, "0")}`, sessionID: SID, permission: "bash", patterns: ["ls"] })

  test("a raw list over MAX_RAW is capped before any owner lookup and flagged partial", async () => {
    const f = fakeContext()
    ours(f)
    f.api.on("GET /permission", { status: 200, data: Array.from({ length: MAX_RAW + 50 }, (_, i) => request(i)) })
    f.api.on("GET /question", { status: 200, data: [] })
    const list = await listPending(f.ctx, f.box, undefined, "cid")
    expect(list.items).toHaveLength(MAX_RAW)
    expect(list.partial).toBe(true)
  })

  test("the time budget stops owner resolution and flags partial", async () => {
    const f = fakeContext()
    ours(f)
    f.api.on("GET /permission", { status: 200, data: [request(1), request(2), request(3)] })
    f.api.on("GET /question", { status: 200, data: [] })
    let clock = 0
    const list = await listPending(f.ctx, f.box, undefined, "cid", { now: () => clock++, deadline: 2 })
    expect(list.items.length).toBeLessThan(3)
    expect(list.partial).toBe(true)
  })
})
