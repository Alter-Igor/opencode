// #118: the supervisor's own check that the box cannot reach the cloud metadata endpoint, whoever
// was supposed to lock egress down. A TCP connect that succeeds means the box is not locked:
// refuse to start. Anything else (refused, unreachable, timeout) passes.
// #123: also verifies the lockdown marker written by egress/lockdown.ts when required.
import { readFile } from "fs/promises"
import net from "net"

export const METADATA = { host: "169.254.169.254", port: 80 }
export const LOCKDOWN_MARKER_ENV = "SBXW_LOCKDOWN_MARKER"
export const REQUIRE_LOCKDOWN_ENV = "SBXW_REQUIRE_LOCKDOWN"
export const DEFAULT_LOCKDOWN_MARKER = "/run/sbxw-egress.locked"

export type GuardResult = { ok: true; detail: string } | { ok: false; detail: string }

export type LockdownMarker = {
  lockedAt: string
  allowHosts: string[]
}

/** Resolves ok when `target` cannot be connected to (refused, unreachable or timeout); not ok if it accepts. */
export function checkUnreachable(target = METADATA, timeoutMs = 1500): Promise<GuardResult> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: target.host, port: target.port })
    const done = (result: GuardResult) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs, () => done({ ok: true, detail: "timed out" }))
    socket.once("connect", () => done({ ok: false, detail: `${target.host}:${target.port} accepted a connection` }))
    socket.once("error", (error: NodeJS.ErrnoException) => done({ ok: true, detail: error.code ?? "error" }))
  })
}

/**
 * #123: verifies the marker file written by `egress/lockdown.ts` after nftables rules load.
 * Fails closed with EGRESS_CHECK_FAILED when missing, unreadable, or malformed.
 */
export async function checkLockdownMarker(
  markerPath = process.env[LOCKDOWN_MARKER_ENV] || DEFAULT_LOCKDOWN_MARKER,
): Promise<GuardResult> {
  let raw = ""
  try {
    raw = await readFile(markerPath, "utf8")
  } catch {
    return { ok: false, detail: `EGRESS_CHECK_FAILED: lockdown marker ${markerPath} is missing` }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, detail: `EGRESS_CHECK_FAILED: lockdown marker ${markerPath} is not a JSON object` }
    }
    const record = parsed as Record<string, unknown>
    if (typeof record.lockedAt !== "string" || !record.lockedAt.trim() || Number.isNaN(Date.parse(record.lockedAt))) {
      return { ok: false, detail: `EGRESS_CHECK_FAILED: lockdown marker ${markerPath} has an invalid lockedAt timestamp` }
    }
    if (!Array.isArray(record.allowHosts) || !record.allowHosts.every((host) => typeof host === "string")) {
      return { ok: false, detail: `EGRESS_CHECK_FAILED: lockdown marker ${markerPath} has an invalid allowHosts list` }
    }
    return { ok: true, detail: `locked at ${record.lockedAt}` }
  } catch {
    return { ok: false, detail: `EGRESS_CHECK_FAILED: lockdown marker ${markerPath} is not valid JSON` }
  }
}

/**
 * #123: fail-closed supervisor egress check combining the lockdown marker check (when
 * `SBXW_REQUIRE_LOCKDOWN !== "0"`) and the metadata unreachability probe.
 */
export async function checkEgress(options?: {
  target?: { host: string; port: number }
  timeoutMs?: number
  markerPath?: string
  requireLockdown?: boolean
}): Promise<GuardResult> {
  const requireLockdown = options?.requireLockdown ?? process.env[REQUIRE_LOCKDOWN_ENV] !== "0"
  if (requireLockdown) {
    const marker = await checkLockdownMarker(options?.markerPath)
    if (!marker.ok) return marker
  }
  const metadata = await checkUnreachable(options?.target, options?.timeoutMs)
  if (!metadata.ok) {
    return { ok: false, detail: `EGRESS_CHECK_FAILED: ${metadata.detail}` }
  }
  return { ok: true, detail: metadata.detail }
}
