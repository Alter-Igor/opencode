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

const IMAGE = "img:1.0.0-abcdef0"
const L = {
  hash: "com.alterspective.opencode-delegate.profile-hash",
  port: "com.alterspective.opencode-delegate.port",
  image: "com.alterspective.opencode-delegate.image",
}

type Call = { argv: string[]; env?: Record<string, string> }
type Box = { running: boolean; labels: Record<string, string>; env: string[] }
type Overrides = { up?: (env: Record<string, string>) => ExecResult | undefined; down?: ExecResult; imageMissing?: boolean; inspect?: ExecResult }

let home: string
let made: DelegateSupervisor[] = []
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "ocd-sup-"))
  made = []
})
afterEach(async () => {
  for (const sup of made) await sup.release().catch(() => undefined)
  await rm(home, { recursive: true, force: true })
})

const owner = JSON.stringify({
  model: "synapse/auto",
  provider: { synapse: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://synapse2-api.alterspective.com.au/v1" } } },
})

function fakeDocker(state: Box, calls: Call[], over: Overrides = {}): Exec {
  return async (argv: string[], options?: ExecOptions) => {
    calls.push({ argv, env: options?.env })
    const sub = argv.slice(1).find((a) => ["version", "inspect", "image", "compose"].includes(a))
    if (sub === "version") return { code: 0, stdout: "29.8.0\n", stderr: "" }
    if (sub === "image") return over.imageMissing ? { code: 1, stdout: "", stderr: "No such image" } : { code: 0, stdout: "sha256:x", stderr: "" }
    if (sub === "inspect") {
      if (over.inspect) return over.inspect
      if (!state.running) return { code: 1, stdout: "", stderr: "Error: No such container: opencode-delegate" }
      return { code: 0, stdout: JSON.stringify({ state: { Running: true, Health: { Status: "healthy" } }, labels: state.labels, env: state.env, image: IMAGE }), stderr: "" }
    }
    if (argv.includes("up")) {
      const env = options?.env ?? {}
      const failed = over.up?.(env)
      if (failed) return failed
      state.running = true
      state.labels = { [L.hash]: env.OCD_PROFILE_HASH!, [L.port]: env.OCD_PORT!, [L.image]: env.OCD_IMAGE! }
      state.env = [`OPENCODE_SERVER_PASSWORD=${env.OPENCODE_SERVER_PASSWORD}`, `OPENCODE_MCP_ALLOW=${env.OPENCODE_MCP_ALLOW}`]
    }
    if (argv.includes("down")) {
      if (over.down) return over.down
      state.running = false
    }
    return { code: 0, stdout: "", stderr: "" }
  }
}

type Line = { level: Level; msg: string; fields: Record<string, unknown> }

function recorder(): Logger & { lines: Line[] } {
  const lines: Line[] = []
  return { lines, log: (level, _component, msg, fields = {}) => void lines.push({ level, msg, fields }) }
}

const probe: ProcessProbe = { alive: () => true, startTime: async () => undefined }

function deps(exec: Exec, over: Partial<SupervisorDeps> = {}): SupervisorDeps {
  const config = { ...defaultConfig({ OPENCODE_DELEGATE_HOME: home }), boxEnv: ["SYNAPSE_API_KEY"] }
  return {
    config, bridgeId: "bridge-a", pid: process.pid, image: IMAGE, opencodeVersion: "1.0.0-alterspective.abcdef0",
    composeFile: "compose.yaml", ownerConfigDir: path.join(home, "owner"), permission: [{ permission: "*", pattern: "*", action: "allow" }],
    keyEnv: { synapse: "SYNAPSE_API_KEY" }, hostEnv: { PATH: "p", SYNAPSE_API_KEY: "k-value", OTHER_SECRET: "nope" },
    exec, profileFs: nodeProfileFs, leaseFs: nodeLeaseFs, probe,
    fetch: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    freePort: async () => 47123, randomPassword: () => "generated-pw", sleep: async () => {}, now: Date.now,
    every: () => () => {},
    ...over,
  }
}

function supervisor(d: SupervisorDeps): DelegateSupervisor {
  const sup = createSupervisor(d)
  made.push(sup)
  return sup
}

async function writeOwner() {
  await nodeProfileFs.writeText(path.join(home, "owner", "opencode.json"), owner)
}

function fail(promise: Promise<unknown>): Promise<DelegateError> {
  return promise.then(
    () => {
      throw new Error("expected a failure")
    },
    (error: unknown) => error as DelegateError,
  )
}

const leaseDir = () => path.join(home, "leases")

describe("supervisor: start and reuse", () => {
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
    env: ["OPENCODE_SERVER_PASSWORD=x", `OPENCODE_MCP_ALLOW=${allow}`],
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
    expect(exclusive).toEqual(["start.lock"])
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
    expect(await unlabeled.status()).toMatchObject({ state: "unavailable", reason: "The running sandbox is missing its bridge settings." })
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
