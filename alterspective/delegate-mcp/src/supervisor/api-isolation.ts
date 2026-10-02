// #49: host API authority lives in the gate's process namespace, never in the agent box.
import { createHash, timingSafeEqual } from "node:crypto"
import { DelegateError } from "../shared/errors.ts"
import type { ApiTarget } from "../shared/opencode-api.ts"
import { PASSWORD_ENV, VERIFIER_ENV } from "./compose-env.ts"
import { LABEL, type BoxInspect, type Exec } from "./docker.ts"

export const GATE_IMAGE = "alpine/socat:1.8.1.3@sha256:5ffbd6ae916cbad86a58fabe0d6d5a6fd5c2b47ddf031e82996baac9300e732f"
export const MEMORY_PROBE = "/usr/local/lib/ocd-memory-probe.py"

export function isolationTarget(box: BoxInspect, gate: BoxInspect | undefined, project: string, image: string): ApiTarget {
  const password = gate?.env[PASSWORD_ENV]
  const digest = box.env[VERIFIER_ENV] ?? ""
  const port = Number(box.labels[LABEL.port])
  const verifier = password && /^[a-f0-9]{64}$/.test(digest) && timingSafeEqual(createHash("sha256").update(password).digest(), Buffer.from(digest, "hex"))
  const matches = (actual: string[] | undefined, expected: string[]) => actual !== undefined && actual.length === expected.length && expected.every((value) => actual.includes(value))
  const hardened = (value: BoxInspect) => value.privileged === false && value.readonlyRootfs === true && value.pidMode === "" && matches(value.capAdd, []) && matches(value.capDrop, ["ALL"]) && value.securityOpt?.includes("no-new-privileges:true")
  const gatePorts = gate?.ports?.["4096/tcp"]
  const valid = box.running && gate?.running && verifier && box.env[PASSWORD_ENV] === undefined &&
    box.env.OPENCODE_DISABLE_REMOTE_CONFIG === "1" && box.env.OPENCODE_DISABLE_EXTERNAL_PROVIDERS === "1" &&
    Number.isInteger(port) && port > 0 && port <= 65535 && box.image === image && gate.image === GATE_IMAGE &&
    box.labels[LABEL.image] === image && gate.labels[LABEL.image] === image && gate.labels[LABEL.port] === String(port) && gate.labels[LABEL.profileHash] === box.labels[LABEL.profileHash] &&
    matches(box.networks, [`${project}_sealed`]) && matches(gate.networks, [`${project}_sealed`, `${project}_outside`]) &&
    box.ports !== undefined && Object.keys(box.ports).every((key) => box.ports?.[key] === null) && Object.keys(gate.ports ?? {}).length === 1 &&
    gatePorts?.length === 1 && gatePorts[0]?.HostIp === "127.0.0.1" && gatePorts[0]?.HostPort === String(port) &&
    JSON.stringify(gate.command) === JSON.stringify(["TCP-LISTEN:4096,fork,reuseaddr", "TCP:box:4096"]) &&
    JSON.stringify(gate.entrypoint) === JSON.stringify(["socat"]) &&
    JSON.stringify(box.command) === JSON.stringify(["serve", "--hostname", "0.0.0.0", "--port", "4096"]) &&
    JSON.stringify(box.entrypoint) === JSON.stringify(["/usr/local/bin/ocd-start"]) &&
    box.user === "agent" && gate.user === "65534:65534" && hardened(box) && hardened(gate)
  if (!valid || !password) throw new DelegateError("profile_changed", "The running sandbox's API isolation could not be verified.", "Call oc_server_restart with confirm: true to start the managed sandbox; never reuse a legacy password-in-box server.", "box verifier, gate credential or container settings differ from the managed profile")
  return { baseUrl: `http://127.0.0.1:${port}`, password }
}

export type MemoryProtection = {
  ok: boolean
  ptraceScope?: number
  memDenied: boolean
  ptraceDenied: boolean
  vmReadDenied: boolean
  coreDisabled: boolean
  debuggerDisabled: boolean
  verifierOnly: boolean
  codeLoadingRestricted: boolean
  serverCommand: boolean
  listeningPorts: number[]
  problems: string[]
}

export function failedMemory(): MemoryProtection {
  return { ok: false, memDenied: false, ptraceDenied: false, vmReadDenied: false, coreDisabled: false, debuggerDisabled: false, verifierOnly: false, codeLoadingRestricted: false, serverCommand: false, listeningPorts: [], problems: ["server memory and API isolation probe did not pass"] }
}

/** Only trusted probe fields escape Docker; stderr and arbitrary output may contain agent data. */
export async function memoryProtection(exec: Exec, container: string): Promise<MemoryProtection> {
  try {
    const result = await exec(["docker", "exec", container, "/usr/bin/python3", "-I", "-S", MEMORY_PROBE, "--check", "1"], { timeoutMs: 15_000 })
    if (result.code !== 0) return failedMemory()
    const raw: unknown = JSON.parse(result.stdout)
    if (!probeRecord(raw)) return failedMemory()
    const values = raw
    const check = failedMemory()
    for (const key of ["memDenied", "ptraceDenied", "vmReadDenied", "coreDisabled", "debuggerDisabled", "verifierOnly", "codeLoadingRestricted", "serverCommand"] as const) check[key] = values[key] === true
    check.ptraceScope = Number.isInteger(values.ptraceScope) ? Number(values.ptraceScope) : undefined
    check.listeningPorts = Array.isArray(values.listeningPorts) && values.listeningPorts.every((port) => Number.isInteger(port) && port > 0 && port <= 65535) ? values.listeningPorts : []
    check.ok = values.ok === true && check.ptraceScope !== undefined && check.ptraceScope >= 1 && check.ptraceScope <= 3 && check.memDenied && check.ptraceDenied && check.vmReadDenied && check.coreDisabled && check.debuggerDisabled && check.verifierOnly && check.codeLoadingRestricted && check.serverCommand && check.listeningPorts.length === 1 && check.listeningPorts[0] === 4096
    if (check.ok) check.problems = []
    return check
  } catch {
    return failedMemory()
  }
}

function probeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function requireMemoryProtection(exec: Exec, container: string): Promise<void> {
  if ((await memoryProtection(exec, container)).ok) return
  throw new DelegateError("policy_unverified", "The sandbox's server memory protection could not be verified.", "Run oc_doctor. Managed startup needs Linux Yama and denied same-user memory access; do not weaken the host policy.")
}
