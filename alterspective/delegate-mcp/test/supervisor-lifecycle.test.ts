import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { defaultConfig, mcpAllowPolicy } from "../src/shared/config.ts"
import { DelegateError } from "../src/shared/errors.ts"
import type { Level, Logger } from "../src/shared/log.ts"
import type { Exec, ExecOptions, ExecResult } from "../src/supervisor/docker.ts"
import { nodeLeaseFs, type LeaseFs } from "../src/supervisor/leases.ts"
import { boxEnvOverride, composeEnv, createSupervisor, type DelegateSupervisor, type SupervisorDeps } from "../src/supervisor/lifecycle.ts"
import type { ProcessProbe } from "../src/supervisor/process.ts"
import { buildProfile, nodeProfileFs } from "../src/supervisor/profile.ts"
import { IMAGE, L, deps, fail, fakeDocker, home, leaseDir, made, owner, probe, recorder, supervisor, writeOwner, type Box, type Call, type Line, useSupervisorFixture } from "./supervisor-lifecycle-fixture.ts"
import { apiEnv } from "./session-isolation-fixture.ts"

useSupervisorFixture()

describe("supervisor: start and reuse", () => {
  test("a failed live memory check stops before any host API credential is sent", async () => {
    const authorizations: boolean[] = []
    const sup = supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, [], { memory: { code: 1, stdout: '{"ok":false}', stderr: "" } }), {
      fetch: (async (_url, init) => {
        authorizations.push(new Headers(init?.headers).has("authorization"))
        return new Response("", { status: 401 })
      }) as typeof fetch,
    }))
    expect((await fail(sup.ensure())).code).toBe("policy_unverified")
    expect(authorizations).toEqual([false])
    expect(await sup.status()).toMatchObject({ state: "unavailable" })
    expect(authorizations).toEqual([false])
  })
  test("ensure starts the box, passes the password only via child env, and writes no secret to disk", async () => {
    await writeOwner()
    const calls: Call[] = []
    const sup = supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, calls)))
    expect(await sup.ensure()).toEqual({ baseUrl: "http://127.0.0.1:47123", password: "generated-pw" })
    const up = calls.find((c) => c.argv.includes("up"))!
    expect(up.argv).not.toContain("--build")
    expect(up.env!.OPENCODE_SERVER_PASSWORD).toBe("generated-pw")
    expect(up.env!.SYNAPSE_API_KEY).toBe("k-value")
    expect(up.env!.OTHER_SECRET).toBeUndefined()
    expect(up.env!.OCD_CONTAINER).toBe("opencode-delegate")
    expect(JSON.parse(up.env!.OPENCODE_MCP_ALLOW!).remote[0].origin).toBe("https://identity.alterspective.com.au")
    for (const file of await readdir(home, { recursive: true })) {
      const text = await readFile(path.join(home, file), "utf8").catch(() => "")
      expect(text).not.toContain("generated-pw")
      expect(text).not.toContain("k-value")
    }
    const status = await sup.status()
    expect(status).toMatchObject({ state: "running", startedBy: "this-bridge", health: "healthy", policyVerified: true, imageMatches: true, imageTag: IMAGE })
  })

  test("--build is passed only when the image is missing", async () => {
    const calls: Call[] = []
    await supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, calls, { imageMissing: true }))).ensure()
    expect(calls.find((c) => c.argv.includes("up"))!.argv).toContain("--build")
  })

  test("a second bridge reuses the running box; only the last release stops it", async () => {
    const calls: Call[] = []
    const exec = fakeDocker({ running: false, labels: {}, env: [] }, calls)
    const a = supervisor(deps(exec))
    await a.ensure()
    const b = supervisor(deps(exec, { bridgeId: "bridge-b", randomPassword: () => "other" }))
    expect((await b.ensure()).password).toBe("generated-pw")
    expect((await b.status()).state === "running" && (await b.status())).toMatchObject({ startedBy: "other" })
    expect(calls.filter((c) => c.argv.includes("up")).length).toBe(1)
    await a.release()
    expect(calls.some((c) => c.argv.includes("down"))).toBe(false)
    await b.release()
    expect(calls.filter((c) => c.argv.includes("down")).length).toBe(1)
  })

  const running = (over: Partial<Record<keyof typeof L, string>>, allow = mcpAllowPolicy(defaultConfig())): Box => ({
    running: true,
    labels: { [L.hash]: over.hash ?? "old", [L.port]: over.port ?? "4711", [L.image]: over.image ?? IMAGE },
    env: [...apiEnv("x"), `OPENCODE_MCP_ALLOW=${allow}`],
  })

  async function currentHash(): Promise<string> {
    const d = deps(async () => ({ code: 0, stdout: "", stderr: "" }))
    return buildProfile({ ownerConfigs: [owner], config: d.config, permission: d.permission, keyEnv: d.keyEnv }).hash
  }

  test("profile hash mismatch on reuse → profile_changed with a restart action", async () => {
    await writeOwner()
    const error = await fail(supervisor(deps(fakeDocker(running({}), []))).ensure())
    expect(error.code).toBe("profile_changed")
    expect(error.action).toContain("oc_server_restart")
  })

  test("image mismatch on reuse → profile_changed (A-04)", async () => {
    await writeOwner()
    const error = await fail(supervisor(deps(fakeDocker(running({ hash: await currentHash(), image: "img:0.9.0-1111111" }), []))).ensure())
    expect(error.code).toBe("profile_changed")
    expect(error.detail).toContain("img:0.9.0-1111111")
  })

  test("MCP allow policy mismatch on reuse → profile_changed; status reports it unverified (A-05)", async () => {
    await writeOwner()
    const sup = supervisor(deps(fakeDocker(running({ hash: await currentHash() }, '{"remote":[]}'), [])))
    expect((await fail(sup.ensure())).code).toBe("profile_changed")
    expect(await sup.status()).toMatchObject({ state: "running", policyVerified: false })
  })
})

describe("supervisor: leases and the start lock (A-02)", () => {
  test("the lease exists before the health wait and is removed when the start fails", async () => {
    const seen: string[][] = []
    let t = 0
    const sup = supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, []), {
      fetch: (async () => {
        seen.push(await readdir(leaseDir()).catch(() => []))
        return new Response("", { status: 500 })
      }) as unknown as typeof fetch,
      now: () => (t += 10_000),
      healthTimeoutMs: 30_000,
    }))
    const error = await fail(sup.ensure())
    expect(error.code).toBe("server_down")
    expect(error.detail).toContain("HTTP 500")
    expect(seen[0]).toContain("bridge-a")
    expect(await readdir(leaseDir())).toEqual([])
  })

  test("a steady 401 says the credentials do not match (A-12)", async () => {
    let t = 0
    const sup = supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, []), {
      fetch: (async () => new Response("", { status: 401 })) as unknown as typeof fetch,
      now: () => (t += 10_000),
      healthTimeoutMs: 30_000,
    }))
    const error = await fail(sup.ensure())
    expect(error.code).toBe("auth_mismatch")
    expect(error.detail).toContain("credentials mismatch")
  })

  test("release without a lease never stops the box", async () => {
    const calls: Call[] = []
    await supervisor(deps(fakeDocker({ running: true, labels: {}, env: [] }, calls))).release()
    expect(calls.some((c) => c.argv.includes("down"))).toBe(false)
  })

  test("release counts and stops under the start lock", async () => {
    const exclusive: string[] = []
    const spy: LeaseFs = {
      ...nodeLeaseFs,
      write: (file, text, ex) => {
        if (ex) exclusive.push(path.basename(file))
        return nodeLeaseFs.write(file, text, ex)
      },
    }
    const sup = supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, []), { leaseFs: spy }))
    await sup.ensure()
    exclusive.length = 0
    await sup.release()
    // The lock itself, then the guard its release runs under (N-3).
    expect(exclusive).toEqual(["start.lock", "start.lock.guard"])
  })

  test("a failed stop is logged, reported, and the box is still ours (A-09)", async () => {
    const log = recorder()
    const down = { code: 1, stdout: "", stderr: "daemon hiccup" }
    const sup = supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, [], { down }), { log }))
    await sup.ensure()
    const error = await fail(sup.release())
    expect(error.code).toBe("sandbox_unavailable")
    expect(log.lines.some((line) => line.msg === "stop failed" && line.level === "error")).toBe(true)
    expect(await sup.status()).toMatchObject({ startedBy: "this-bridge" })
  })
})

describe("supervisor: failures map to stable codes", () => {
  test("docker down → sandbox_unavailable from ensure, unavailable from status", async () => {
    const sup = supervisor(deps(async () => ({ code: 1, stdout: "", stderr: "error during connect" })))
    expect((await fail(sup.ensure())).code).toBe("sandbox_unavailable")
    expect((await sup.status()).state).toBe("unavailable")
  })

  test("port already allocated → port_busy, and the password never reaches detail (A-12)", async () => {
    const up = (env: Record<string, string>) => ({ code: 1, stdout: "", stderr: `env ${env.OPENCODE_SERVER_PASSWORD} k-value: Bind for 127.0.0.1:47123 failed: port is already allocated` })
    const error = await fail(supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, [], { up }))).ensure())
    expect(error.code).toBe("port_busy")
    expect(error.detail).not.toContain("generated-pw")
    expect(error.detail).not.toContain("k-value")
    expect(error.detail).toContain("[redacted]")
  })

  test("status never throws: unreadable inspect or missing labels → unavailable (A-11)", async () => {
    const garbage = supervisor(deps(fakeDocker({ running: true, labels: {}, env: [] }, [], { inspect: { code: 0, stdout: "nope", stderr: "" } })))
    expect((await garbage.status()).state).toBe("unavailable")
    const unlabeled = supervisor(deps(fakeDocker({ running: true, labels: {}, env: [] }, [])))
    expect(await unlabeled.status()).toMatchObject({ state: "unavailable", reason: "The running sandbox's API isolation could not be verified." })
  })

  test("a plain fs error becomes a DelegateError with the path only in detail (A-07)", async () => {
    const broken = { ...nodeProfileFs, writeText: async () => Promise.reject(Object.assign(new Error("EACCES: denied, open 'C:\\x'"), { code: "EACCES" })) }
    const error = await fail(supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, []), { profileFs: broken })).ensure())
    expect(error).toBeInstanceOf(DelegateError)
    expect(error.code).toBe("sandbox_unavailable")
    expect(error.message).not.toContain("C:\\x")
    expect(error.detail).toContain("EACCES")
  })
})

describe("supervisor: logging (A-17) and login wrapper", () => {
  test("every call and every error is logged with bridgeId and a per-call correlationId", async () => {
    const log = recorder()
    const sup = supervisor(deps(async () => ({ code: 1, stdout: "", stderr: "error during connect" }), { log }))
    await sup.ensure().catch(() => undefined)
    await sup.status()
    const called = log.lines.filter((line) => line.msg.endsWith(" called"))
    expect(called.map((line) => line.msg)).toEqual(["ensure called", "status called"])
    expect(new Set(called.map((line) => line.fields.correlationId)).size).toBe(2)
    const failed = log.lines.find((line) => line.msg === "ensure failed")!
    expect(failed.fields).toMatchObject({ bridgeId: "bridge-a", code: "sandbox_unavailable", correlationId: called[0]!.fields.correlationId })
    expect(String(failed.fields.detail)).toContain("error during connect")
  })

  test("login: not wired → upstream_error; wired → passes through; plain throw → DelegateError", async () => {
    const exec = fakeDocker({ running: false, labels: {}, env: [] }, [])
    expect((await fail(supervisor(deps(exec)).login("ks-delegate"))).code).toBe("upstream_error")
    const seen: string[] = []
    const ok = supervisor(deps(exec, { login: async (entry) => (seen.push(entry), "connected") }))
    expect(await ok.login("ks-delegate")).toBe("connected")
    expect(seen).toEqual(["ks-delegate"])
    const boom = supervisor(deps(exec, { login: async () => Promise.reject(new Error("socket closed")) }))
    const error = await fail(boom.login("ks-delegate"))
    expect(error).toBeInstanceOf(DelegateError)
    expect(error.code).toBe("upstream_error")
  })
})

