// GAP-1: supervisor.replace() (oc_server_restart) recovers from profile_changed under the start lock.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { defaultConfig, mcpAllowPolicy } from "../src/shared/config.ts"
import type { Exec } from "../src/supervisor/docker.ts"
import { nodeLeaseFs } from "../src/supervisor/leases.ts"
import { IMAGE, L, deps, fail, fakeDocker, leaseDir, supervisor, writeOwner, type Box, type Call, useSupervisorFixture } from "./supervisor-lifecycle-fixture.ts"

useSupervisorFixture()

/** A running box from an older profile: ensure() refuses it with profile_changed. */
const mismatched = (): Box => ({
  running: true,
  labels: { [L.hash]: "old", [L.port]: "4711", [L.image]: IMAGE },
  env: ["OPENCODE_SERVER_PASSWORD=x", `OPENCODE_MCP_ALLOW=${mcpAllowPolicy(defaultConfig())}`],
})

/** Another bridge's live lease (this process's PID, fresh heartbeat). */
async function otherLease(id = "bridge-b"): Promise<string> {
  const file = path.join(leaseDir(), id)
  await nodeLeaseFs.write(file, JSON.stringify({ pid: process.pid, bridgeId: id }) + "\n")
  return file
}

const composeCalls = (calls: Call[], sub: "up" | "down") => calls.filter((c) => c.argv.includes("compose") && c.argv.includes(sub))

describe("supervisor.replace (GAP-1)", () => {
  test("a mismatched box with no other lease is replaced: down (never -v), then up with this profile", async () => {
    await writeOwner()
    const calls: Call[] = []
    const sup = supervisor(deps(fakeDocker(mismatched(), calls)))
    const before = await fail(sup.ensure())
    expect(before.code).toBe("profile_changed")
    expect(before.action).toContain("oc_server_restart")
    expect(before.action).not.toContain("force")
    const result = await sup.replace({ force: false })
    expect(result).toEqual({ target: { baseUrl: "http://127.0.0.1:47123", password: "generated-pw" }, interrupted: 0, keystone: ["rag-read", "github", "seqlogs"] })
    const [down] = composeCalls(calls, "down")
    expect(down?.argv).toContain("--remove-orphans")
    expect(down?.argv).not.toContain("-v")
    expect(calls.indexOf(down!)).toBeLessThan(calls.indexOf(composeCalls(calls, "up")[0]!))
    expect(await sup.ensure()).toEqual(result.target)
    expect(await sup.status()).toMatchObject({ state: "running", startedBy: "this-bridge", imageMatches: true })
  })

  test("another live lease → refused (nothing stopped) with an action naming force; force replaces and reports 1", async () => {
    await writeOwner()
    const lease = await otherLease()
    const calls: Call[] = []
    const sup = supervisor(deps(fakeDocker(mismatched(), calls)))
    const blocked = await fail(sup.ensure())
    expect(blocked.code).toBe("profile_changed")
    expect(blocked.action).toContain("1 other bridge is using the sandbox")
    expect(blocked.action).toContain("force: true")
    const refused = await fail(sup.replace({ force: false }))
    expect(refused.code).toBe("profile_changed")
    expect(refused.action).toContain("oc_server_restart")
    expect(refused.action).toContain("force: true")
    expect(composeCalls(calls, "down")).toHaveLength(0)
    const forced = await sup.replace({ force: true })
    expect(forced.interrupted).toBe(1)
    expect(composeCalls(calls, "down")).toHaveLength(1)
    expect(composeCalls(calls, "up")).toHaveLength(1)
    // The other bridge keeps its lease: its next ensure() reuses the new box.
    expect(await nodeLeaseFs.read(lease)).toBeDefined()
  })

  test("a stopped box is started even while another lease exists; nobody is interrupted", async () => {
    await otherLease()
    const calls: Call[] = []
    const result = await supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, calls))).replace({ force: false })
    expect(result.interrupted).toBe(0)
    expect(composeCalls(calls, "up")).toHaveLength(1)
  })

  test("the start lock is held throughout: a concurrent ensure waits, then reuses the new box", async () => {
    await writeOwner()
    const calls: Call[] = []
    const inner = fakeDocker(mismatched(), calls)
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => (open = resolve))
    let downing = false
    const exec: Exec = async (argv, options) => {
      if (argv.includes("down")) {
        downing = true
        await gate
      }
      return inner(argv, options)
    }
    const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const a = supervisor(deps(exec))
    const b = supervisor(deps(exec, { bridgeId: "bridge-b", sleep: () => tick(5) }))
    const replacing = a.replace({ force: false })
    while (!downing) await tick(5)
    let ensured = false
    const waiting = b.ensure().then((target) => ((ensured = true), target))
    await tick(100)
    expect(ensured).toBe(false)
    expect(composeCalls(calls, "up")).toHaveLength(0)
    open()
    const [replaced, reused] = await Promise.all([replacing, waiting])
    expect(reused).toEqual(replaced.target)
    expect(composeCalls(calls, "up")).toHaveLength(1)
    expect((await b.status()).state === "running" && (await b.status())).toMatchObject({ startedBy: "other" })
  })
})
