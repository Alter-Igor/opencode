import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { defaultConfig } from "../src/shared/config.ts"
import { DelegateError } from "../src/shared/errors.ts"
import type { Exec, ExecOptions } from "../src/supervisor/docker.ts"
import { createLeases, nodeLeaseFs, withStartLock, type LeaseFs } from "../src/supervisor/leases.ts"
import { boxEnvOverride, composeEnv, createSupervisor, type SupervisorDeps } from "../src/supervisor/lifecycle.ts"
import { buildProfile, nodeProfileFs } from "../src/supervisor/profile.ts"

function memoryLeaseFs(): LeaseFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    list: async (dir) => [...files.keys()].filter((f) => path.dirname(f) === dir).map((f) => path.basename(f)),
    read: async (file) => files.get(file),
    write: async (file, text, exclusive) => {
      if (exclusive && files.has(file)) return false
      files.set(file, text)
      return true
    },
    remove: async (file) => void files.delete(file),
    mtime: async (file) => (files.has(file) ? 0 : undefined),
  }
}

describe("leases", () => {
  test("release reports remaining live leases and prunes dead ones", async () => {
    const fs = memoryLeaseFs()
    const leases = createLeases(fs, "L", (pid) => pid !== 999)
    await leases.acquire("a", 1)
    await leases.acquire("b", 2)
    await leases.acquire("dead", 999)
    expect(await leases.active()).toEqual(["a", "b"])
    expect(await leases.release("a")).toBe(1)
    expect(await leases.release("b")).toBe(0)
    expect(fs.files.size).toBe(0)
  })

  test("bridge ids cannot escape the lease folder", async () => {
    const leases = createLeases(memoryLeaseFs(), "L", () => true)
    await expect(leases.acquire("../x", 1)).rejects.toThrow()
  })

  test("start lock is exclusive and released after the run", async () => {
    const fs = memoryLeaseFs()
    const order: string[] = []
    let clock = 0
    const opts = { now: () => clock, sleep: async (ms: number) => void (clock += ms), staleMs: 1_000_000 }
    const first = withStartLock(fs, "lock", async () => {
      order.push("first-start")
      await Promise.resolve()
      order.push("first-end")
    }, opts)
    const second = withStartLock(fs, "lock", async () => void order.push("second"), opts)
    await Promise.all([first, second])
    expect(order).toEqual(["first-start", "first-end", "second"])
    expect(fs.files.has("lock")).toBe(false)
  })
})

describe("compose inputs", () => {
  test("override lists box env names only, never values", () => {
    expect(boxEnvOverride(["SYNAPSE_API_KEY"])).toBe("services:\n  box:\n    environment:\n      SYNAPSE_API_KEY:\n")
    expect(() => boxEnvOverride(["BAD NAME"])).toThrow()
  })
})

type Call = { argv: string[]; env?: Record<string, string> }

let home: string
beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "ocd-sup-"))
})
afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

const owner = JSON.stringify({
  model: "synapse/auto",
  provider: { synapse: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://synapse2-api.alterspective.com.au/v1" } } },
})

function fakeDocker(state: { running: boolean; labels: Record<string, string>; env: string[] }, calls: Call[]): Exec {
  return async (argv: string[], options?: ExecOptions) => {
    calls.push({ argv, env: options?.env })
    const sub = argv.slice(1).find((a) => ["version", "inspect", "image", "compose"].includes(a))
    if (sub === "version") return { code: 0, stdout: "29.8.0\n", stderr: "" }
    if (sub === "image") return { code: 0, stdout: "sha256:x", stderr: "" }
    if (sub === "inspect") {
      if (!state.running) return { code: 1, stdout: "", stderr: "No such container" }
      return { code: 0, stdout: JSON.stringify({ state: { Running: true }, labels: state.labels, env: state.env, image: "img:1-abcdef0" }), stderr: "" }
    }
    if (argv.includes("up")) {
      const env = options?.env ?? {}
      state.running = true
      state.labels = { "com.alterspective.opencode-delegate.profile-hash": env.OCD_PROFILE_HASH!, "com.alterspective.opencode-delegate.port": env.OCD_PORT! }
      state.env = [`OPENCODE_SERVER_PASSWORD=${env.OPENCODE_SERVER_PASSWORD}`]
    }
    if (argv.includes("down")) state.running = false
    return { code: 0, stdout: "", stderr: "" }
  }
}

function deps(exec: Exec, over: Partial<SupervisorDeps> = {}): SupervisorDeps {
  const config = { ...defaultConfig({ OPENCODE_DELEGATE_HOME: home }), boxEnv: ["SYNAPSE_API_KEY"] }
  return {
    config, bridgeId: "bridge-a", pid: process.pid, image: "img:1-abcdef0", opencodeVersion: "1-alterspective.abcdef0",
    composeFile: "compose.yaml", ownerConfigDir: path.join(home, "owner"), permission: [{ permission: "*", pattern: "*", action: "allow" }],
    keyEnv: { synapse: "SYNAPSE_API_KEY" }, hostEnv: { PATH: "p", SYNAPSE_API_KEY: "k-value", OTHER_SECRET: "nope" },
    exec, profileFs: nodeProfileFs, leaseFs: nodeLeaseFs, isAlive: () => true,
    fetch: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    freePort: async () => 47123, randomPassword: () => "generated-pw", sleep: async () => {}, now: Date.now,
    ...over,
  }
}

describe("supervisor lifecycle", () => {
  test("ensure starts the box, passes the password only via child env, and writes no secret to disk", async () => {
    await nodeProfileFs.writeText(path.join(home, "owner", "opencode.json"), owner)
    const calls: Call[] = []
    const state = { running: false, labels: {}, env: [] as string[] }
    const sup = createSupervisor(deps(fakeDocker(state, calls)))
    const target = await sup.ensure()
    expect(target).toEqual({ baseUrl: "http://127.0.0.1:47123", password: "generated-pw" })
    const up = calls.find((c) => c.argv.includes("up"))!
    expect(up.argv).not.toContain("--build")
    expect(up.env!.OPENCODE_SERVER_PASSWORD).toBe("generated-pw")
    expect(up.env!.SYNAPSE_API_KEY).toBe("k-value")
    expect(up.env!.OTHER_SECRET).toBeUndefined()
    expect(JSON.parse(up.env!.OPENCODE_MCP_ALLOW!).remote[0].origin).toBe("https://identity.alterspective.com.au")
    for (const file of await readdir(home, { recursive: true })) {
      const full = path.join(home, file)
      const text = await readFile(full, "utf8").catch(() => "")
      expect(text).not.toContain("generated-pw")
      expect(text).not.toContain("k-value")
    }
    expect((await sup.status()).state).toBe("running")
  })

  test("a second bridge reuses the running box with the password from docker inspect", async () => {
    const calls: Call[] = []
    const state = { running: false, labels: {}, env: [] as string[] }
    const exec = fakeDocker(state, calls)
    const a = createSupervisor(deps(exec))
    await a.ensure()
    const b = createSupervisor(deps(exec, { bridgeId: "bridge-b", randomPassword: () => "other" }))
    expect((await b.ensure()).password).toBe("generated-pw")
    expect(calls.filter((c) => c.argv.includes("up")).length).toBe(1)
    await a.release()
    expect(calls.some((c) => c.argv.includes("down"))).toBe(false)
    await b.release()
    expect(calls.filter((c) => c.argv.includes("down")).length).toBe(1)
  })

  test("profile hash mismatch on reuse → profile_changed", async () => {
    const state = { running: true, labels: { "com.alterspective.opencode-delegate.profile-hash": "old", "com.alterspective.opencode-delegate.port": "1" }, env: ["OPENCODE_SERVER_PASSWORD=x"] }
    const error = await createSupervisor(deps(fakeDocker(state, []))).ensure().catch((e: unknown) => e)
    expect((error as DelegateError).code).toBe("profile_changed")
  })

  test("docker down → sandbox_unavailable from ensure, unavailable from status", async () => {
    const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "error during connect" })
    const sup = createSupervisor(deps(exec))
    expect(((await sup.ensure().catch((e: unknown) => e)) as DelegateError).code).toBe("sandbox_unavailable")
    expect((await sup.status()).state).toBe("unavailable")
  })

  test("unhealthy after start → server_down", async () => {
    let t = 0
    const sup = createSupervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, []), {
      fetch: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
      now: () => (t += 10_000), healthTimeoutMs: 30_000,
    }))
    expect(((await sup.ensure().catch((e: unknown) => e)) as DelegateError).code).toBe("server_down")
  })

  test("compose env carries the profile hash that buildProfile computed", () => {
    const d = deps(fakeDocker({ running: false, labels: {}, env: [] }, []))
    const built = buildProfile({ ownerConfigs: [owner], config: d.config, permission: d.permission, keyEnv: d.keyEnv })
    const env = composeEnv(d, built, 1, "pw")
    expect(env.OCD_PROFILE_HASH).toBe(built.hash)
    expect(env.OCD_PROFILE_DIR).toBe(path.join(home, "profile"))
  })
})
