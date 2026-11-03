// #265: Generation-aware dead lease sweep across <home>/leases and <home>/generations/<gen>/leases,
// plus oc_doctor reporting of lease pruning and session bloat counts.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { LEASE_STALE_MS, sweepAllLeases } from "../src/supervisor/leases.ts"
import { doctorTool } from "../src/tools/doctor.ts"
import { data, fakeContext, invoke, seedState, SID } from "./tools-core-fixture.ts"

const dirs: string[] = []
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ocd-leases-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function writeLeaseFile(
  file: string,
  record: Record<string, unknown> | string,
  mtimeMs: number,
): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const text = typeof record === "string" ? record : JSON.stringify(record)
  writeFileSync(file, text, "utf8")
  const mtime = new Date(mtimeMs)
  utimesSync(file, mtime, mtime)
}

describe("#265 sweepAllLeases across base and generation lease folders", () => {
  test("enumerates <home>/leases and <home>/generations/<gen>/leases, unlinking stale dead PIDs", async () => {
    const home = tempHome()
    const now = Date.now()
    const staleIso = new Date(now - LEASE_STALE_MS - 10_000).toISOString()
    const freshIso = new Date(now - 5_000).toISOString()

    writeFileSync(
      path.join(home, "generations.json"),
      JSON.stringify({
        version: 1,
        next: 4,
        boxes: [
          { project: "opencode-delegate-g2", ceiling: ["ks-a"], createdAt: staleIso },
          { project: "opencode-delegate-g3", ceiling: ["ks-a", "ks-b"], createdAt: freshIso },
        ],
      }),
      "utf8",
    )

    // 1. Live lease in base <home>/leases
    const baseLiveFile = path.join(home, "leases", "bridge-live.json")
    writeLeaseFile(
      baseLiveFile,
      { id: "bridge-live", pid: 1001, startedAt: staleIso, updatedAt: freshIso },
      now - 5_000,
    )

    // 2. Dead & stale lease in base <home>/leases -> should be unlinked & counted in pruned
    const baseDeadFile = path.join(home, "leases", "bridge-dead-base.json")
    writeLeaseFile(
      baseDeadFile,
      { id: "bridge-dead-base", pid: 2002, startedAt: staleIso, updatedAt: staleIso },
      now - LEASE_STALE_MS - 10_000,
    )

    // 3. Dead & stale lease in generation g2 -> should be unlinked & counted in pruned
    const g2DeadFile = path.join(home, "generations", "opencode-delegate-g2", "leases", "bridge-dead-g2.json")
    writeLeaseFile(
      g2DeadFile,
      { id: "bridge-dead-g2", pid: 2003, startedAt: staleIso, updatedAt: staleIso },
      now - LEASE_STALE_MS - 20_000,
    )

    // 4. Live lease in generation g3 -> should be retained
    const g3LiveFile = path.join(home, "generations", "opencode-delegate-g3", "leases", "bridge-live-g3.json")
    writeLeaseFile(
      g3LiveFile,
      { id: "bridge-live-g3", pid: 1002, startedAt: freshIso, updatedAt: freshIso },
      now - 2_000,
    )

    // 5. Dead lease in an unlisted generation directory on disk -> should also be discovered and swept
    const g1DeadFile = path.join(home, "generations", "opencode-delegate-g1", "leases", "bridge-dead-g1.json")
    writeLeaseFile(
      g1DeadFile,
      { id: "bridge-dead-g1", pid: 2004, startedAt: staleIso, updatedAt: staleIso },
      now - LEASE_STALE_MS - 30_000,
    )

    // 6. Dead lease that is still fresh (within LEASE_STALE_MS grace window) -> NOT unlinked yet
    const freshDeadFile = path.join(home, "leases", "bridge-dead-fresh.json")
    writeLeaseFile(
      freshDeadFile,
      { id: "bridge-dead-fresh", pid: 2005, startedAt: freshIso, updatedAt: freshIso },
      now - 10_000,
    )

    const result = await sweepAllLeases(home, {
      now: () => now,
      probe: { alive: (pid) => pid === 1001 || pid === 1002 },
    })

    expect(result.pruned).toBe(3)
    expect(existsSync(baseDeadFile)).toBe(false)
    expect(existsSync(g2DeadFile)).toBe(false)
    expect(existsSync(g1DeadFile)).toBe(false)
    expect(existsSync(baseLiveFile)).toBe(true)
    expect(existsSync(g3LiveFile)).toBe(true)
    expect(existsSync(freshDeadFile)).toBe(true)

    expect(result.activeSupervisors.has("bridge-live")).toBe(true)
    expect(result.activeSupervisors.has("bridge-live-g3")).toBe(true)
    expect(result.activeSupervisors.has("bridge-dead-base")).toBe(false)
    expect(result.activeSupervisors.has("bridge-dead-g2")).toBe(false)
    expect(result.activeSupervisors.has("bridge-dead-g1")).toBe(false)
  })

  test("corrupt JSON lease: kept as unknown while fresh, unlinked when older than LEASE_STALE_MS", async () => {
    const home = tempHome()
    const now = Date.now()

    const freshCorrupt = path.join(home, "leases", "fresh-corrupt.json")
    writeLeaseFile(freshCorrupt, "{not-valid-json", now - 5_000)

    const staleCorrupt = path.join(home, "generations", "opencode-delegate-g2", "leases", "stale-corrupt.json")
    writeLeaseFile(staleCorrupt, "{truncated", now - LEASE_STALE_MS - 5_000)

    const result = await sweepAllLeases(home, {
      now: () => now,
      probe: { alive: () => false },
    })

    // Fresh corrupt JSON is never treated as confirmed dead while fresh
    expect(existsSync(freshCorrupt)).toBe(true)
    expect(result.leases.some((l) => l.bridgeId === "fresh-corrupt" && l.unknown === true)).toBe(true)
    expect(result.activeSupervisors.has("fresh-corrupt")).toBe(true)

    // Stale corrupt JSON is unlinked and counted in pruned
    expect(existsSync(staleCorrupt)).toBe(false)
    expect(result.pruned).toBe(1)
  })

  test("oc_doctor surfaces leases: { count, pruned, items } and sessions: { trackedInProcess, hostRecordsTotal }", async () => {
    const home = tempHome()
    const now = Date.now()
    const staleIso = new Date(now - LEASE_STALE_MS - 15_000).toISOString()

    // Plant 1 dead stale lease in a generation folder and 1 live lease (current process.pid)
    writeLeaseFile(
      path.join(home, "generations", "opencode-delegate-g2", "leases", "dead-gen-bridge.json"),
      { id: "dead-gen-bridge", pid: 999_999_999, startedAt: staleIso, updatedAt: staleIso },
      now - LEASE_STALE_MS - 15_000,
    )
    writeLeaseFile(
      path.join(home, "leases", "live-self.json"),
      { id: "live-self", pid: process.pid, startedAt: new Date(now - 5_000).toISOString(), updatedAt: new Date(now - 1_000).toISOString() },
      now - 1_000,
    )

    const f = fakeContext()
    f.ctx.config.home = home
    // Seed 3 host records, while tracking only 1 in f.ctx.sessions
    seedState(f, { sessionKey: "s-0000000001", sessionID: SID })
    seedState(f, { sessionKey: "s-0000000002", sessionID: "ses_000000000000000002" })
    seedState(f, { sessionKey: "s-0000000003", sessionID: "ses_000000000000000003" })
    f.ctx.sessions.set(SID, {
      sessionID: SID,
      sessionKey: "s-0000000001",
      hostRepo: "C:\\GitHub\\demo",
      boxPath: "/sessions/s-0000000001",
      branch: "delegate/s-0000000001",
      profile: "standard",
      createdAt: staleIso,
      base: "b".repeat(40),
    })

    const res = await invoke(doctorTool, {}, f.ctx)
    const out = data(res)
    expect(out.leases).toMatchObject({
      count: 1,
      pruned: 1,
    })
    expect((out.leases as { items: Array<{ bridgeId: string }> }).items.map((i) => i.bridgeId)).toEqual(["live-self"])
    expect(out.sessions).toEqual({
      trackedInProcess: 1,
      hostRecordsTotal: 3,
    })
  })
})
