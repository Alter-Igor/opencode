import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DelegateError } from "../src/shared/errors.ts"
import { createLeases, nodeLeaseFs, parseRecord, type LeaseFs } from "../src/supervisor/leases.ts"
import { fileTimeToMs, recordGone, type ProcessProbe } from "../src/supervisor/process.ts"
import { withStartLock, type LockOptions } from "../src/supervisor/start-lock.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ocd-lease-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Probe over a fake process table: pid → start time (absent = dead). */
function table(entries: Record<number, number | undefined>): ProcessProbe {
  return { alive: (pid) => pid in entries, startTime: async (pid) => entries[pid] }
}

describe("leases", () => {
  test("release reports remaining live leases and prunes dead ones", async () => {
    const leases = createLeases(nodeLeaseFs, dir, { probe: table({ 1: 100, 2: 200 }), now: Date.now })
    await leases.acquire("a", { pid: 1, startedAt: 100 })
    await leases.acquire("b", { pid: 2, startedAt: 200 })
    await leases.acquire("dead", { pid: 999, startedAt: 1 })
    expect(await leases.active()).toEqual(["a", "b"])
    expect(await leases.release("a")).toBe(1)
    expect(await leases.release("b")).toBe(0)
    expect(await readdir(dir)).toEqual([])
  })

  test("a reused PID only counts once the heartbeat is old (A-18/A-19)", async () => {
    let now = Date.now()
    const leases = createLeases(nodeLeaseFs, dir, { probe: table({ 7: 5_000_000 }), now: () => now })
    await leases.acquire("x", { pid: 7, startedAt: 1_000 })
    expect(await leases.active()).toEqual(["x"])
    now += 6 * 60_000
    expect(await leases.active()).toEqual([])
  })

  test("an old heartbeat with the same process is kept; heartbeat refreshes mtime", async () => {
    let now = Date.now()
    const leases = createLeases(nodeLeaseFs, dir, { probe: table({ 7: 1_000 }), now: () => now })
    await leases.acquire("x", { pid: 7, startedAt: 1_000 })
    now += 60 * 60_000
    expect(await leases.active()).toEqual(["x"])
    expect(await leases.heartbeat("x")).toBe(true)
    expect(await leases.heartbeat("missing")).toBe(false)
  })

  test("lease writes are atomic JSON and the Wave 1 format is still read", async () => {
    const leases = createLeases(nodeLeaseFs, dir, { probe: table({ 3: 9 }), now: Date.now })
    await leases.acquire("a", { pid: 3, startedAt: 9 })
    expect(parseRecord(await readFile(path.join(dir, "a"), "utf8"))).toEqual({ pid: 3, startedAt: 9 })
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    await writeFile(path.join(dir, "legacy"), "3\n2026-10-01T00:00:00Z\n")
    expect(await leases.active()).toEqual(["a", "legacy"])
  })

  test("bridge ids cannot escape the lease folder", async () => {
    const leases = createLeases(nodeLeaseFs, dir, { probe: table({}), now: Date.now })
    const error = await leases.acquire("../x", { pid: 1 }).catch((e: unknown) => e)
    expect((error as DelegateError).code).toBe("invalid_input")
  })

  test("recordGone: dead, reused, same, unknown start time", async () => {
    const probe = table({ 5: 10_000, 6: undefined })
    expect(await recordGone({ pid: 4, startedAt: 1 }, probe)).toBe(true)
    expect(await recordGone({ pid: 5, startedAt: 90_000 }, probe)).toBe(true)
    expect(await recordGone({ pid: 5, startedAt: 11_000 }, probe)).toBe(false)
    expect(await recordGone({ pid: 6, startedAt: 1 }, probe)).toBe(false)
    expect(fileTimeToMs("116444736000000000")).toBe(0)
  })
})

describe("start lock on the real filesystem", () => {
  const lockFile = () => path.join(dir, "start.lock")
  const me = { pid: 42, startedAt: 4_200 }

  function options(over: Partial<LockOptions> = {}): LockOptions {
    return { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), probe: table({ 42: 4_200, 43: 4_300 }), self: me, every: () => () => {}, ...over }
  }

  test("the lock file is created exclusively (wx) and removed after the run", async () => {
    let inside = ""
    await withStartLock(nodeLeaseFs, lockFile(), async () => void (inside = await readFile(lockFile(), "utf8")), options())
    expect(JSON.parse(inside)).toMatchObject({ pid: 42, startedAt: 4_200 })
    expect(await nodeLeaseFs.write(lockFile(), "x", true)).toBe(true)
    expect(await nodeLeaseFs.write(lockFile(), "y", true)).toBe(false)
  })

  test("runs are serialised", async () => {
    const order: string[] = []
    const first = withStartLock(nodeLeaseFs, lockFile(), async () => {
      order.push("first-start")
      await new Promise((r) => setTimeout(r, 30))
      order.push("first-end")
    }, options())
    await new Promise((r) => setTimeout(r, 5))
    const second = withStartLock(nodeLeaseFs, lockFile(), async () => void order.push("second"), options({ self: { pid: 43, startedAt: 4_300 } }))
    await Promise.all([first, second])
    expect(order).toEqual(["first-start", "first-end", "second"])
  })

  test("a live, heartbeating holder is waited for, not taken over (A-01)", async () => {
    await writeFile(lockFile(), JSON.stringify({ token: "other", pid: 43, startedAt: 4_300 }))
    let clock = Date.now()
    let sleeps = 0
    const sleep = async () => {
      sleeps++
      clock += 60_000
      await utimes(lockFile(), new Date(clock), new Date(clock))
      if (sleeps === 20) await rm(lockFile())
    }
    let ran = false
    await withStartLock(nodeLeaseFs, lockFile(), async () => void (ran = true), options({ now: () => clock, sleep }))
    expect(ran).toBe(true)
    expect(sleeps).toBe(20)
  })

  test("a dead holder is taken over at once", async () => {
    await writeFile(lockFile(), JSON.stringify({ token: "gone", pid: 999, startedAt: 1 }))
    let sleeps = 0
    await withStartLock(nodeLeaseFs, lockFile(), async () => {}, options({ sleep: async () => void sleeps++ }))
    expect(sleeps).toBe(0)
    expect(await readdir(dir)).toEqual([])
  })

  test("a holder whose heartbeat stopped is taken over", async () => {
    await writeFile(lockFile(), JSON.stringify({ token: "hung", pid: 43, startedAt: 4_300 }))
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(lockFile(), old, old)
    let ran = false
    await withStartLock(nodeLeaseFs, lockFile(), async () => void (ran = true), options())
    expect(ran).toBe(true)
  })

  test("waiting on a live holder times out with sandbox_unavailable", async () => {
    await writeFile(lockFile(), JSON.stringify({ token: "other", pid: 43, startedAt: 4_300 }))
    let clock = Date.now()
    const sleep = async () => {
      clock += 60_000
      await utimes(lockFile(), new Date(clock), new Date(clock))
    }
    const error = await withStartLock(nodeLeaseFs, lockFile(), async () => {}, options({ now: () => clock, sleep, waitMs: 10 * 60_000 })).catch((e: unknown) => e)
    expect((error as DelegateError).code).toBe("sandbox_unavailable")
    expect(JSON.parse(await readFile(lockFile(), "utf8")).token).toBe("other")
  })

  test("release leaves a lock that is no longer ours in place", async () => {
    await withStartLock(nodeLeaseFs, lockFile(), async () => {
      await rm(lockFile())
      await writeFile(lockFile(), JSON.stringify({ token: "someone-else", pid: 43 }))
    }, options())
    expect(JSON.parse(await readFile(lockFile(), "utf8")).token).toBe("someone-else")
  })

  test("an unreadable lock is waited on with sleeps and times out, never a busy spin (N-2)", async () => {
    let reads = 0
    let sleeps = 0
    let clock = 0
    const fs: LeaseFs = {
      ...nodeLeaseFs,
      write: async () => false, // the lock exists...
      read: async () => {
        if (++reads > 10_000) throw new Error("busy spin: read the lock 10000 times without sleeping")
        return undefined // ...but cannot be read (EACCES, or mid-replace)
      },
      mtime: async () => clock,
    }
    const sleep = async () => {
      sleeps++
      clock += 60_000
    }
    const error = await withStartLock(fs, lockFile(), async () => {}, options({ now: () => clock, sleep, waitMs: 10 * 60_000 })).catch((e: unknown) => e)
    expect((error as DelegateError).code).toBe("sandbox_unavailable")
    expect((error as DelegateError).detail).toContain("unreadable")
    expect(sleeps).toBeGreaterThanOrEqual(10)
    expect(reads).toBe(sleeps + 1)
  })

  test("a take-over never removes a lock another bridge took meanwhile: one holder at a time (N-3)", async () => {
    // A hung holder's lock is old. Just before our take-over, another bridge takes it over first
    // and now holds a fresh lock. We must leave that lock alone and wait for it.
    await writeFile(lockFile(), JSON.stringify({ token: "hung", pid: 43, startedAt: 4_300 }))
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(lockFile(), old, old)
    const other = JSON.stringify({ token: "other-bridge", pid: 43, startedAt: 4_300 })
    let otherHolds = false
    let injected = false
    const violations: string[] = []
    const fs: LeaseFs = {
      ...nodeLeaseFs,
      async write(file, text, exclusive) {
        const ok = await nodeLeaseFs.write(file, text, exclusive)
        if (ok && file.endsWith(".guard") && !injected) {
          // The other bridge finished its own take-over between our judgement and our guard.
          injected = true
          await rm(lockFile())
          await nodeLeaseFs.write(lockFile(), other, true)
          otherHolds = true
        }
        return ok
      },
      async remove(file) {
        if (file === lockFile() && otherHolds && (await nodeLeaseFs.read(file)) === other) violations.push("removed the other bridge's lock")
        return nodeLeaseFs.remove(file)
      },
    }
    let sleeps = 0
    const sleep = async () => {
      if (++sleeps === 3) {
        await nodeLeaseFs.remove(lockFile()) // the other bridge releases
        otherHolds = false
      }
    }
    let ranWhileOtherHeld = false
    await withStartLock(fs, lockFile(), async () => void (ranWhileOtherHeld = otherHolds), options({ sleep }))
    expect(violations).toEqual([])
    expect(ranWhileOtherHeld).toBe(false)
    expect(sleeps).toBe(3)
    expect(await readdir(dir)).toEqual([])
  })

  test("many waiters on one stale lock: exactly one runs at a time (N-3)", async () => {
    await writeFile(lockFile(), JSON.stringify({ token: "gone", pid: 999, startedAt: 1 }))
    let inside = 0
    let most = 0
    const contenders = Array.from({ length: 8 }, (_, i) =>
      withStartLock(nodeLeaseFs, lockFile(), async () => {
        most = Math.max(most, ++inside)
        await new Promise((r) => setTimeout(r, 5))
        inside--
      }, options({ self: { pid: 100 + i, startedAt: 1 }, probe: { alive: (pid) => pid !== 999, startTime: async () => 1 } })),
    )
    await Promise.all(contenders)
    expect(most).toBe(1)
    expect(await readdir(dir)).toEqual([])
  })

  test("a waiter reads the holder's start time once, and only when its heartbeat is late (N-6)", async () => {
    await writeFile(lockFile(), JSON.stringify({ token: "other", pid: 43, startedAt: 4_300 }))
    let probes = 0
    const probe: ProcessProbe = { alive: () => true, startTime: async () => (probes++, 4_300) }
    let clock = Date.now()
    let sleeps = 0
    // Fresh heartbeat: no start-time probe at all, however long we wait.
    const fresh = async () => {
      clock += 20_000
      await utimes(lockFile(), new Date(clock), new Date(clock))
      if (++sleeps === 10) await rm(lockFile())
    }
    await withStartLock(nodeLeaseFs, lockFile(), async () => {}, options({ now: () => clock, sleep: fresh, probe }))
    expect(sleeps).toBe(10)
    expect(probes).toBe(0)
    // Late heartbeat (2-5 min old): probed once, then remembered for every later wait.
    await writeFile(lockFile(), JSON.stringify({ token: "other", pid: 43, startedAt: 4_300 }))
    const late = new Date(clock - 3 * 60_000)
    await utimes(lockFile(), late, late)
    sleeps = 0
    const idle = async () => {
      if (++sleeps === 10) await rm(lockFile())
    }
    await withStartLock(nodeLeaseFs, lockFile(), async () => {}, options({ now: () => clock, sleep: idle, probe }))
    expect(sleeps).toBe(10)
    expect(probes).toBe(1)
  })

  test("the holder refreshes its heartbeat while it works", async () => {
    const beats: Array<() => void> = []
    const touched: string[] = []
    const fs: LeaseFs = { ...nodeLeaseFs, touch: async (file) => (touched.push(path.basename(file)), true) }
    await withStartLock(fs, lockFile(), async () => beats.forEach((beat) => beat()), options({ every: (fn) => (beats.push(fn), () => {}) }))
    expect(touched).toEqual(["start.lock"])
  })
})
