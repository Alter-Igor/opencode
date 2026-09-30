import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { defaultConfig, mcpAllowPolicy } from "../src/shared/config.ts"
import { DelegateError } from "../src/shared/errors.ts"
import type { Level, Logger } from "../src/shared/log.ts"
import type { Exec, ExecOptions, ExecResult } from "../src/supervisor/docker.ts"
import { nodeLeaseFs, type LeaseFs } from "../src/supervisor/leases.ts"
import { boxEnvOverride, composeEnv, createSupervisor, handoffOutMode, type DelegateSupervisor, type SupervisorDeps } from "../src/supervisor/lifecycle.ts"
import type { ProcessProbe } from "../src/supervisor/process.ts"
import { buildProfile, nodeProfileFs } from "../src/supervisor/profile.ts"
import { IMAGE, L, deps, fail, fakeDocker, home, leaseDir, made, owner, probe, recorder, supervisor, writeOwner, type Box, type Call, type Line, useSupervisorFixture } from "./supervisor-lifecycle-fixture.ts"

useSupervisorFixture()

describe("supervisor: round-2 review fixes", () => {
  test("down gets the same -f files as up, --remove-orphans, cwd = home, and no secret in its env (N-1)", async () => {
    const calls: Call[] = []
    const sup = supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, calls)))
    await sup.ensure()
    await sup.release()
    const up = calls.find((c) => c.argv.includes("up"))!
    const down = calls.find((c) => c.argv.includes("down"))!
    const files = (argv: string[]) => argv.flatMap((a, i) => (argv[i - 1] === "-f" ? [a] : []))
    expect(files(down.argv)).toEqual(files(up.argv))
    expect(files(down.argv)).toEqual(["compose.yaml", path.join(home, "compose.box-env.yaml")])
    expect(down.argv.slice(-2)).toEqual(["down", "--remove-orphans"])
    expect(down.argv).not.toContain("-v")
    expect(down.cwd).toBe(home)
    expect(down.env!.OCD_IMAGE).toBe(IMAGE)
    expect(down.env!.OCD_HANDOFF_DIR).toBe(path.join(home, "handoff"))
    expect(down.env!.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(down.env!.SYNAPSE_API_KEY).toBeUndefined()
    expect(Object.values(down.env!)).not.toContain("generated-pw")
  })

  const inspectJson = (labels: Record<string, string>): ExecResult => ({
    code: 0,
    stdout: JSON.stringify({ state: { Running: true }, labels, env: [], image: "x" }),
    stderr: "",
  })

  async function reusable(): Promise<Box> {
    await writeOwner()
    const d = deps(async () => ({ code: 0, stdout: "", stderr: "" }))
    const hash = buildProfile({ ownerConfigs: [owner], config: d.config, permission: d.permission, keyEnv: d.keyEnv }).hash
    return { running: true, labels: { [L.hash]: hash, [L.port]: "4711", [L.image]: IMAGE }, env: ["OPENCODE_SERVER_PASSWORD=x", `OPENCODE_MCP_ALLOW=${mcpAllowPolicy(defaultConfig())}`] }
  }

  test("reuse checks egress and the caches came from the same checkout (N-9)", async () => {
    const box = await reusable()
    expect((await supervisor(deps(fakeDocker(box, []))).ensure()).baseUrl).toBe("http://127.0.0.1:4711")
    const stale = { "opencode-delegate-egress": inspectJson({ [L.image]: "img:0.9.0-1111111" }) }
    const error = await fail(supervisor(deps(fakeDocker(box, [], { containers: stale }))).ensure())
    expect(error.code).toBe("profile_changed")
    expect(error.message).toContain("egress")
    expect(error.detail).toContain("img:0.9.0-1111111")
    const missing = { "opencode-delegate-pypi-cache": { code: 1, stdout: "", stderr: "Error: No such container: opencode-delegate-pypi-cache" } }
    const gone = await fail(supervisor(deps(fakeDocker(box, [], { containers: missing }))).ensure())
    expect(gone.code).toBe("profile_changed")
    expect(gone.detail).toContain("container missing")
  })

  test("reuse refuses a set whose inbox (or any sibling) is stopped (W2C-12)", async () => {
    const box = await reusable()
    const stopped = { "opencode-delegate-inbox": { code: 0, stdout: JSON.stringify({ state: { Running: false }, labels: { [L.image]: IMAGE }, env: [], image: "x" }), stderr: "" } }
    const error = await fail(supervisor(deps(fakeDocker(box, [], { containers: stopped }))).ensure())
    expect(error.code).toBe("sandbox_unavailable")
    expect(error.message).toContain("inbox service is stopped")
  })

  test("a lease heartbeat in flight during release cannot re-create the lease (N-10)", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = []
    let gate: ((value: boolean) => void) | undefined
    const leaseFile = path.join(home, "leases", "bridge-a")
    const fs: LeaseFs = {
      ...nodeLeaseFs,
      touch: (file) => (file === leaseFile && !gate ? new Promise<boolean>((resolve) => (gate = resolve)) : nodeLeaseFs.touch(file)),
    }
    const calls: Call[] = []
    const sup = supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, calls), { leaseFs: fs, every: (fn, ms) => (timers.push({ fn, ms }), () => {}) }))
    await sup.ensure()
    const beat = timers.find((t) => t.ms === 60_000)!
    beat.fn() // the beat now waits on touch
    const releasing = sup.release()
    await new Promise((r) => setTimeout(r, 20))
    gate!(false) // "lease file gone": an unstopped beat would acquire it again
    await releasing
    await new Promise((r) => setTimeout(r, 50))
    expect(await readdir(leaseDir())).toEqual([])
    expect(calls.filter((c) => c.argv.includes("down"))).toHaveLength(1)
  })

  test("status and ensure never throw because the logger does (A-11)", async () => {
    const log: Logger = {
      log() {
        throw new Error("log sink down")
      },
    }
    const sup = supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, []), { log }))
    expect((await sup.ensure()).baseUrl).toBe("http://127.0.0.1:47123")
    expect((await sup.status()).state).toBe("running")
    const broken = supervisor(deps(async () => ({ code: 1, stdout: "", stderr: "error during connect" }), { log }))
    expect((await broken.status()).state).toBe("unavailable")
    expect((await fail(broken.ensure())).code).toBe("sandbox_unavailable")
  })

  test("handoff/out is opened for uid 10001 only on non-Windows hosts (N-12)", () => {
    expect(handoffOutMode("win32")).toBeUndefined()
    expect(handoffOutMode("linux")).toBe(0o777)
    expect(handoffOutMode("darwin")).toBe(0o777)
  })
})

describe("compose inputs", () => {
  test("override lists box env names only, never values", () => {
    expect(boxEnvOverride(["SYNAPSE_API_KEY"])).toBe("services:\n  box:\n    environment:\n      SYNAPSE_API_KEY:\n")
    expect(() => boxEnvOverride(["BAD NAME"])).toThrow(DelegateError)
  })

  test("compose env carries the profile hash and the container name for the project", () => {
    const d = deps(fakeDocker({ running: false, labels: {}, env: [] }, []))
    const built = buildProfile({ ownerConfigs: [owner], config: d.config, permission: d.permission, keyEnv: d.keyEnv })
    const env = composeEnv(d, built, 1, "pw")
    expect(env.OCD_PROFILE_HASH).toBe(built.hash)
    expect(env.OCD_PROFILE_DIR).toBe(path.join(home, "profile"))
    expect(composeEnv({ ...d, config: { ...d.config, project: "ocd-fixtest" } }, built, 1, "pw").OCD_CONTAINER).toBe("ocd-fixtest")
  })
})
