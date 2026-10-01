// Review N1 (confirmation review of e1df93ae5c): a start writes front's generated files under the
// Synapse refresh lock, so a refresh (which writes the include and reloads front under that lock)
// never overlaps it. Lock order: start lock, then the Synapse lock; the Synapse code never takes the
// start lock, so the reverse order (and a deadlock) cannot happen.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { nodeLeaseFs } from "../src/supervisor/leases.ts"
import { withStartLock } from "../src/supervisor/start-lock.ts"
import { synapseLockFile } from "../src/synapse/lock.ts"
import { deps, fakeDocker, home, probe, supervisor, useSupervisorFixture, writeOwner, type Call } from "./supervisor-lifecycle-fixture.ts"

useSupervisorFixture()

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe("review N1: front's files are written under the Synapse refresh lock", () => {
  test("while a refresh holds the Synapse lock, a start waits: no servers.conf written, no `up`; then it goes on", async () => {
    await writeOwner()
    const calls: Call[] = []
    const servers = path.join(home, "front", "servers.conf")
    let started: Promise<unknown> | undefined
    const seenWhileHeld = await withStartLock(nodeLeaseFs, synapseLockFile(home), async () => {
      started = supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, calls), { sleep: (ms) => sleep(Math.min(ms, 20)) })).ensure()
      await sleep(400)
      // The start took the start lock and prepared the other folders, but not front's files.
      return { servers: existsSync(servers), up: calls.some((c) => c.argv.includes("up")), startLock: existsSync(path.join(home, "start.lock")) }
    }, { now: Date.now, sleep, probe, self: { pid: process.pid, startedAt: 7 }, waitMs: 10_000 })
    expect(seenWhileHeld).toEqual({ servers: false, up: false, startLock: true })
    await started
    expect(readFileSync(servers, "utf8")).toContain("server {")
    expect(calls.some((c) => c.argv.includes("up"))).toBe(true)
  })

  test("the Synapse code never takes the start lock (so the order is always start lock, then Synapse lock)", () => {
    const dir = path.join(import.meta.dir, "..", "src", "synapse")
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(path.join(dir, file), "utf8")
      expect({ file, startLock: /start\.lock|startLock|withLease/.test(text) }).toEqual({ file, startLock: false })
    }
    const lifecycle = readFileSync(path.join(import.meta.dir, "..", "src", "supervisor", "lifecycle.ts"), "utf8")
    // The only Synapse-lock use in the supervisor is inside prepareFiles, which runs under the start lock.
    expect(lifecycle.match(/dirs\.synapseLock/g)?.length).toBe(2)
    expect(lifecycle.indexOf("withStartLock(deps.leaseFs, dirs.synapseLock")).toBeGreaterThan(lifecycle.indexOf("async function prepareFiles"))
  })
})
