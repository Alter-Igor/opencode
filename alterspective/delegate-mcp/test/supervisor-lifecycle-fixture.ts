// Shared fixture for the supervisor lifecycle tests (split to keep each file under 400 lines).
// `home` and `made` are live ES-module bindings reset by the hooks below for every test.
import { afterEach, beforeEach } from "bun:test"
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
import { GATE_IMAGE, MEMORY_PROBE } from "../src/supervisor/api-isolation.ts"
import { apiEnv, MEMORY_OK } from "./session-isolation-fixture.ts"

export const IMAGE = "img:1.0.0-abcdef0"
export const L = {
  hash: "com.alterspective.opencode-delegate.profile-hash",
  port: "com.alterspective.opencode-delegate.port",
  image: "com.alterspective.opencode-delegate.image",
  // On front (R4-01); the fake answers every sibling inspect with the box state, so the box carries it too.
  front: "com.alterspective.opencode-delegate.front-config",
}

export type Call = { argv: string[]; env?: Record<string, string>; cwd?: string }
export type Box = { running: boolean; labels: Record<string, string>; env: string[]; password?: string }
export type Overrides = {
  up?: (env: Record<string, string>) => ExecResult | undefined
  down?: ExecResult
  imageMissing?: boolean
  inspect?: ExecResult
  /** Inspect result for a named container (the box's egress/cache siblings, N-9). */
  containers?: Record<string, ExecResult>
  /** `docker exec` into the box (R5-01 sign-in store). Default: an empty store, nothing removed. */
  exec?: (argv: string[]) => ExecResult
  memory?: ExecResult
}

export let home: string
export let made: DelegateSupervisor[] = []
/** Call once at the top of each test file: Bun evaluates this module once per run, so hooks must be registered per file. */
export function useSupervisorFixture() {
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "ocd-sup-"))
    made = []
  })
  afterEach(async () => {
    for (const sup of made) await sup.release().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
}

export const owner = JSON.stringify({
  model: "synapse/auto",
  provider: { synapse: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://synapse2-api.alterspective.com.au/v1" } } },
})

export function fakeDocker(state: Box, calls: Call[], over: Overrides = {}): Exec {
  return async (argv: string[], options?: ExecOptions) => {
    calls.push({ argv, env: options?.env, cwd: options?.cwd })
    if (argv[1] === "exec") return argv.includes(MEMORY_PROBE) ? over.memory ?? { code: 0, stdout: JSON.stringify(MEMORY_OK), stderr: "" } : over.exec?.(argv) ?? { code: 0, stdout: JSON.stringify({ names: [], removed: [] }), stderr: "" }
    const sub = argv.slice(1).find((a) => ["version", "inspect", "image", "compose"].includes(a))
    if (sub === "version") return { code: 0, stdout: "29.8.0\n", stderr: "" }
    if (sub === "image") return over.imageMissing ? { code: 1, stdout: "", stderr: "No such image" } : { code: 0, stdout: "sha256:x", stderr: "" }
    if (sub === "inspect") {
      const named = over.containers?.[argv.at(-1) ?? ""]
      if (named) return named
      if (over.inspect) return over.inspect
      if (!state.running) return { code: 1, stdout: "", stderr: "Error: No such container: opencode-delegate" }
      const gate = argv.at(-1)?.endsWith("-gate-box")
      return { code: 0, stdout: JSON.stringify({ state: { Running: true, Health: { Status: "healthy" } }, labels: state.labels, env: gate ? [`OPENCODE_SERVER_PASSWORD=${state.password ?? "x"}`] : state.env, image: gate ? GATE_IMAGE : IMAGE,
        networks: { "opencode-delegate_sealed": {}, ...(gate ? { "opencode-delegate_outside": {} } : {}) }, ports: gate ? { "4096/tcp": [{ HostIp: "127.0.0.1", HostPort: state.labels[L.port] }] } : {},
        command: gate ? ["TCP-LISTEN:4096,fork,reuseaddr", "TCP:box:4096"] : ["serve", "--hostname", "0.0.0.0", "--port", "4096"], entrypoint: gate ? ["socat"] : ["/usr/local/bin/ocd-start"],
        user: gate ? "65534:65534" : "agent", pidMode: "", privileged: false, capAdd: null, capDrop: ["ALL"], securityOpt: ["no-new-privileges:true"], readonlyRootfs: true }), stderr: "" }
    }
    if (argv.includes("up")) {
      const env = options?.env ?? {}
      const failed = over.up?.(env)
      if (failed) return failed
      state.running = true
      state.labels = { [L.hash]: env.OCD_PROFILE_HASH!, [L.port]: env.OCD_PORT!, [L.image]: env.OCD_IMAGE!, [L.front]: env.OCD_FRONT_HASH! }
      state.password = env.OPENCODE_SERVER_PASSWORD!
      state.env = [...apiEnv(state.password), `OPENCODE_MCP_ALLOW=${env.OPENCODE_MCP_ALLOW}`]
    }
    if (argv.includes("down")) {
      if (over.down) return over.down
      state.running = false
    }
    return { code: 0, stdout: "", stderr: "" }
  }
}

export type Line = { level: Level; msg: string; fields: Record<string, unknown> }

export function recorder(): Logger & { lines: Line[] } {
  const lines: Line[] = []
  return { lines, log: (level, _component, msg, fields = {}) => void lines.push({ level, msg, fields }) }
}

export const probe: ProcessProbe = { alive: () => true, startTime: async () => undefined }

export function deps(exec: Exec, over: Partial<SupervisorDeps> = {}): SupervisorDeps {
  const config = { ...defaultConfig({ OPENCODE_DELEGATE_HOME: home }), boxEnv: ["SYNAPSE_API_KEY"] }
  return {
    config, bridgeId: "bridge-a", pid: process.pid, image: IMAGE, opencodeVersion: "1.0.0-alterspective.abcdef0",
    composeFile: "compose.yaml", ownerConfigDir: path.join(home, "owner"), permission: [{ permission: "*", pattern: "*", action: "allow" }],
    keyEnv: { synapse: "SYNAPSE_API_KEY" }, hostEnv: { PATH: "p", SYNAPSE_API_KEY: "k-value", OTHER_SECRET: "nope" },
    exec, profileFs: nodeProfileFs, leaseFs: nodeLeaseFs, probe,
    fetch: (async (_url, init) => new Response("", { status: new Headers(init?.headers).has("authorization") ? 200 : 401 })) as typeof fetch,
    freePort: async () => 47123, randomPassword: () => "generated-pw", sleep: async () => {}, now: Date.now,
    every: () => () => {},
    ...over,
  }
}

export function supervisor(d: SupervisorDeps): DelegateSupervisor {
  const sup = createSupervisor(d)
  made.push(sup)
  return sup
}

export async function writeOwner() {
  await nodeProfileFs.writeText(path.join(home, "owner", "opencode.json"), owner)
}

export function fail(promise: Promise<unknown>): Promise<DelegateError> {
  return promise.then(
    () => {
      throw new Error("expected a failure")
    },
    (error: unknown) => error as DelegateError,
  )
}

export const leaseDir = () => path.join(home, "leases")
