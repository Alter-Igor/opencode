// MOD-01: wait for the boxed OpenCode server to answer with the bridge's password (A-12).
// The last probe result is kept so a failure says why (a steady 401 = password mismatch).
import { DelegateError } from "../shared/errors.ts"
import type { ApiTarget } from "../shared/opencode-api.ts"

export type HealthDeps = {
  fetch: typeof fetch
  now: () => number
  sleep: (ms: number) => Promise<void>
  healthTimeoutMs?: number
}

type Probe = { ok: boolean; note: string }

async function probeOnce(deps: HealthDeps, target: ApiTarget): Promise<Probe> {
  const auth = "Basic " + Buffer.from(`${target.username ?? "opencode"}:${target.password}`).toString("base64")
  try {
    // Per-probe timeout: Docker Desktop can accept on the published port before the gate is
    // wired and then hold the connection open (observed live), so one probe must never hang.
    const res = await deps.fetch(`${target.baseUrl}/path?directory=/sessions`, { headers: { authorization: auth }, signal: AbortSignal.timeout(3000) })
    return { ok: res.status === 200, note: `HTTP ${res.status}` }
  } catch (error) {
    return { ok: false, note: `no answer (${error instanceof Error ? error.name : "error"})` }
  }
}

export async function waitHealthy(deps: HealthDeps, target: ApiTarget, container: string): Promise<void> {
  const deadline = deps.now() + (deps.healthTimeoutMs ?? 120_000)
  let last = "no probe ran"
  while (deps.now() < deadline) {
    const probe = await probeOnce(deps, target)
    if (probe.ok) return
    last = probe.note
    await deps.sleep(1000)
  }
  if (last === "HTTP 401")
    throw new DelegateError(
      "auth_mismatch",
      "The sandbox is running but refused this bridge's password.",
      "Restart the sandbox with oc_server_restart.",
      "last probe: HTTP 401 (credentials mismatch: the box password differs from the one the bridge holds)",
    )
  throw new DelegateError(
    "server_down",
    "The sandbox started but OpenCode did not become healthy in time.",
    `Run oc_doctor; check \`docker logs ${container}\`.`,
    `last probe: ${last}`,
  )
}
