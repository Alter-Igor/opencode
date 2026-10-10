// Live-verified 2026-10-10: a running box whose saved set leaves this bridge's ceiling made the
// doctor say "sandbox unavailable" AND "delegation gate: not checked (the sandbox is not running)"
// while the gate container was healthy — a ceiling mismatch masqueraded as a dead gate.
// The doctor must say which of the three it is, probe the gate anyway, and list bridge leases.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { saveKeystoneSet } from "../src/shared/keystone.ts"
import type { SupervisorStatus } from "../src/supervisor/status.ts"
import { doctorTool } from "../src/tools/doctor.ts"
import { data, fakeContext, invoke, text, type Fake } from "./tools-core-fixture.ts"

const scratch = mkdtempSync(path.join(os.tmpdir(), "ocd-doctor-ceiling-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0

/** A home whose saved set is the live one: rag-read, github, seqlogs, dynamic (ceiling: no dynamic). */
function mismatchHome(leases?: Array<{ id: string; pid: number; ageSec: number }>): string {
  const home = path.join(scratch, `home-${n++}`)
  saveKeystoneSet(home, ["rag-read", "github", "seqlogs", "dynamic"])
  if (leases) {
    mkdirSync(path.join(home, "leases"), { recursive: true })
    for (const lease of leases) {
      const file = path.join(home, "leases", lease.id)
      writeFileSync(file, JSON.stringify({ pid: lease.pid, startedAt: 1, bridgeId: lease.id, at: new Date().toISOString() }))
      utimesSync(file, new Date(Date.now() - lease.ageSec * 1000), new Date(Date.now() - lease.ageSec * 1000))
    }
  }
  return home
}

/** The fixture's running status, marked as one this bridge's ceiling excludes (2026-10-10 shape). */
function mismatched(f: Fake): SupervisorStatus {
  if (f.status.value.state !== "running") throw new Error("fixture starts running")
  return { ...f.status.value, ceilingMismatch: ["dynamic"], policyVerified: false, frontMatches: false }
}
const MCP = { status: 200, data: { "ks-rag-read": { status: "connected" }, "ks-github": { status: "connected" }, "ks-seqlogs": { status: "connected" }, "ks-dynamic": { status: "connected" } } }

describe("oc_doctor with a running box outside this ceiling", () => {
  test("says the box IS RUNNING, names the ids outside the ceiling, and gives both exits", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.config.home = mismatchHome()
    f.ctx.config.keystoneAllowed = ["rag-read", "github", "seqlogs"]
    f.status.value = mismatched(f)
    f.api.on("GET /mcp", MCP)
    const result = await invoke(doctorTool, {}, f.ctx)
    const line = text(result)
    expect(line).toContain("the sandbox IS RUNNING")
    expect(line).toContain("dynamic")
    expect(line).toContain("oc_server_restart")
    expect(line).toContain("OPENCODE_DELEGATE_KEYSTONE_ALLOWED")
    expect(line).not.toContain("sandbox is not running")
    expect(data(result)).toMatchObject({ verified: false, box: { state: "running", ceilingMismatch: ["dynamic"], policyVerified: false, health: "healthy" } })
  })

  test("the gate is PROBED for real even though this bridge cannot use the box", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.config.home = mismatchHome()
    f.ctx.config.keystoneAllowed = ["rag-read", "github", "seqlogs"]
    f.status.value = mismatched(f)
    f.api.on("GET /mcp", MCP)
    let calls = 0
    f.gate.pending = async () => { calls++; return [] as never[] }
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(calls).toBe(1)
    expect(data(result)).toMatchObject({ gate: { used: true, reachable: true, waitingApprovals: 0 } })
    expect(text(result)).toContain("Delegation gate: ok")
  })

  test("a gate that cannot be reached is reported AS that, never as the sandbox's fault", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.config.home = mismatchHome()
    f.ctx.config.keystoneAllowed = ["rag-read", "github", "seqlogs"]
    f.status.value = mismatched(f)
    f.api.on("GET /mcp", MCP)
    f.gate.pending = async () => { throw new Error("The delegation gate could not be reached.") }
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result)).toMatchObject({ gate: { reachable: false } })
    expect(text(result)).toContain("Delegation gate: NOT reachable")
  })

  test("a stopped box still says so, and an unreachable one is never renamed running", async () => {
    const f = fakeContext({ boxHeld: false })
    f.status.value = { state: "unavailable", reason: "Docker not reachable" }
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(text(result)).toContain("Sandbox unavailable")
    expect(data(result)).toMatchObject({ verified: false, box: { state: "unavailable" } })
  })

  test("leases are listed with pid, liveness and idle, newest first, capped at 20", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.config.home = mismatchHome([
      { id: "bridge-old", pid: 999_999, ageSec: 7200 },
      { id: "bridge-live", pid: process.pid, ageSec: 10 },
    ])
    f.ctx.config.keystoneAllowed = ["rag-read", "github", "seqlogs"]
    f.status.value = mismatched(f)
    f.api.on("GET /mcp", MCP)
    const result = await invoke(doctorTool, {}, f.ctx)
    const leases = data(result).leases as { count: number; leases: Array<{ bridgeId: string; alive?: boolean; idleSec?: number }> }
    expect(leases.count).toBe(2)
    expect(leases.leases[0]).toMatchObject({ bridgeId: "bridge-live", alive: true })
    expect(leases.leases[1]).toMatchObject({ bridgeId: "bridge-old", alive: false })
    expect((leases.leases[0]?.idleSec ?? -1)).toBeLessThan(leases.leases[1]?.idleSec ?? 0)
  })

  test("no leases folder is reported, not a crash", async () => {
    const f = fakeContext({ boxHeld: false })
    const empty = path.join(scratch, `home-${n++}`)
    mkdirSync(empty, { recursive: true })
    f.ctx.config.home = empty
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result).leases).toMatchObject({ count: 0, leases: [] })
  })
})
