import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { isolationTarget, GATE_IMAGE, memoryProtection } from "../src/supervisor/api-isolation.ts"
import { type BoxInspect, LABEL } from "../src/supervisor/docker.ts"
import { boxEnvOverride, PASSWORD_ENV, VERIFIER_ENV } from "../src/supervisor/compose-env.ts"

const password = "sentinel-host-only-password-0123456789"
const digest = createHash("sha256").update(password).digest("hex")
const project = "isolated-test"
function pair(): { box: BoxInspect; gate: BoxInspect } {
  const labels = { [LABEL.port]: "47123", [LABEL.image]: "box:1", [LABEL.profileHash]: "profile" }
  return {
    box: { running: true, health: "healthy", labels, image: "box:1", env: { [VERIFIER_ENV]: digest, OPENCODE_DISABLE_REMOTE_CONFIG: "1", OPENCODE_DISABLE_EXTERNAL_PROVIDERS: "1" }, networks: [`${project}_sealed`], ports: {}, command: ["serve", "--hostname", "0.0.0.0", "--port", "4096"], entrypoint: ["/usr/local/bin/ocd-start"], pidMode: "", user: "agent", privileged: false, capAdd: [], capDrop: ["ALL"], securityOpt: ["no-new-privileges:true"], readonlyRootfs: true },
    gate: { running: true, health: "none", labels, image: GATE_IMAGE, env: { [PASSWORD_ENV]: password }, networks: [`${project}_sealed`, `${project}_outside`], ports: { "4096/tcp": [{ HostIp: "127.0.0.1", HostPort: "47123" }] }, command: ["TCP-LISTEN:4096,fork,reuseaddr", "TCP:box:4096"], entrypoint: ["socat"], pidMode: "", user: "65534:65534", privileged: false, capAdd: [], capDrop: ["ALL"], securityOpt: ["no-new-privileges:true"], readonlyRootfs: true },
  }
}

describe("#49 host-only API credential", () => {
  test("adoption uses the gate password after checking the box verifier and sealed topology", () => {
    const { box, gate } = pair()
    expect(isolationTarget(box, gate, project, "box:1")).toEqual({ baseUrl: "http://127.0.0.1:47123", password })
  })
  test("legacy env, wrong digest, missing gate and altered gate settings fail without exposing secrets", () => {
    const mutations = [
      (b: BoxInspect) => { b.env[PASSWORD_ENV] = password },
      (b: BoxInspect) => { b.env[VERIFIER_ENV] = "0".repeat(64) },
      (_: BoxInspect, g: BoxInspect) => { g.image = "other:1" },
      (_: BoxInspect, g: BoxInspect) => { g.networks = [`${project}_outside`] },
      (_: BoxInspect, g: BoxInspect) => { g.ports = { "4096/tcp": [{ HostIp: "0.0.0.0", HostPort: "47123" }] } },
      (b: BoxInspect) => { b.pidMode = "host" },
      (b: BoxInspect) => { b.env.OPENCODE_DISABLE_REMOTE_CONFIG = "0" },
      (b: BoxInspect) => { b.capAdd = ["SYS_PTRACE"] },
    ]
    for (const mutate of mutations) {
      const { box, gate } = pair()
      mutate(box, gate)
      try { isolationTarget(box, gate, project, "box:1"); throw new Error("accepted") } catch (error) {
        expect(String(error)).not.toContain(password)
        expect(String(error)).not.toContain(digest)
        expect(String(error)).not.toContain("accepted")
      }
    }
    expect(() => isolationTarget(pair().box, undefined, project, "box:1")).toThrow()
  })
  test("box compose contains the digest only and its liveness check expects an auth challenge", () => {
    const compose = Bun.YAML.parse(readFileSync(new URL("../docker/compose.yaml", import.meta.url), "utf8")) as { services: { box: { environment: Record<string, unknown>; healthcheck: unknown; ulimits: { core: unknown } }; "gate-box": { environment: Record<string, unknown> } } }
    expect(compose.services.box.environment).not.toHaveProperty(PASSWORD_ENV)
    expect(compose.services.box.environment).toHaveProperty(VERIFIER_ENV)
    expect(compose.services["gate-box"].environment).toHaveProperty(PASSWORD_ENV)
    expect(JSON.stringify(compose.services.box.healthcheck)).not.toContain(PASSWORD_ENV)
    expect(JSON.stringify(compose.services.box.healthcheck)).toContain("401")
    expect(compose.services.box.ulimits.core).toEqual({ soft: 0, hard: 0 })
  })
  test("loader and debugger env cannot be copied into the server", () => {
    for (const name of ["LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "BUN_INSPECT", "BUN_INSPECT_CONNECT_TO", "JSC_dumpOptions", "OPENCODE_AUTO_HEAP_SNAPSHOT"])
      expect(() => boxEnvOverride([name])).toThrow()
  })
})

describe("#49 memory protection", () => {
  const good = { ok: true, ptraceScope: 1, memDenied: true, ptraceDenied: true, vmReadDenied: true, coreDisabled: true, debuggerDisabled: true, verifierOnly: true, codeLoadingRestricted: true, serverCommand: true, listeningPorts: [4096] }
  test("unknown probes, one failed probe and extra listeners never count as verified", async () => {
    for (const body of [undefined, {}, { ...good, memDenied: false }, { ...good, ptraceScope: 0 }, { ...good, listeningPorts: [4096, 6499] }]) {
      const check = await memoryProtection(async () => ({ code: 0, stdout: JSON.stringify(body) ?? "", stderr: "" }), project)
      expect(check.ok).toBe(false)
    }
    expect((await memoryProtection(async () => ({ code: 0, stdout: JSON.stringify(good), stderr: "" }), project)).ok).toBe(true)
  })
})
