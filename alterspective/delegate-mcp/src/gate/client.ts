// #104: the bridge's side of the delegation gate (mcp-gate): list the tool calls waiting for an
// approval and approve or refuse one. Like the inbox (src/inbox/target.ts), the admin token exists
// only in bridge memory and in the GATE container's env, so any bridge reads it back with
// `docker inspect <project>-mcp-gate` together with the host port label. The token never appears in
// errors or logs. A failed read is an error, never "no approvals".
import { type ApprovalView } from "../../mcp-gate/src/approvals.ts"
import type { BridgeConfig } from "../shared/config.ts"
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { GATE_ADMIN_PORT_LABEL, GATE_ADMIN_TOKEN_ENV, containerName } from "../supervisor/compose-env.ts"
import { inspectBox, type BoxInspect, type Exec } from "../supervisor/docker.ts"

export type GateTarget = { baseUrl: string; token: string }
export type { ApprovalView }

/** Approval ids as the gate makes them (mcp-gate/src/approvals.ts). */
export const APPROVAL_ID_RE = /^apr_[a-z0-9]{1,40}$/
export const GATE_TIMEOUT_MS = 10_000

export const gateContainer = (config: Pick<BridgeConfig, "project">) => `${containerName(config)}-mcp-gate`

function unavailable(message: string, detail: string): DelegateError {
  return new DelegateError("sandbox_unavailable", message, "Run oc_doctor; if the sandbox was restarted, retry. Do not treat this as \"nothing waiting\".", detail)
}

/** Where the gate's admin API is, from Docker (needs the owner's Docker access, not a file). */
export async function gateTargetFromDocker(exec: Exec, config: Pick<BridgeConfig, "project">): Promise<GateTarget> {
  let inspected: BoxInspect | undefined
  try {
    inspected = await inspectBox(exec, [GATE_ADMIN_TOKEN_ENV], gateContainer(config))
  } catch (error) {
    throw unavailable("The delegation gate is not running.", isDelegateError(error) ? `${error.code}: ${error.detail ?? ""}`.slice(0, 300) : "inspect failed")
  }
  if (!inspected?.running) throw unavailable("The delegation gate is not running.", inspected ? "container stopped" : "container missing")
  const token = inspected.env[GATE_ADMIN_TOKEN_ENV]
  const port = Number(inspected.labels[GATE_ADMIN_PORT_LABEL])
  if (!token || !Number.isInteger(port) || port <= 0 || port > 65535) throw unavailable("The delegation gate's admin API cannot be located.", `token ${token ? "present" : "missing"}, port label ${inspected.labels[GATE_ADMIN_PORT_LABEL] ?? "missing"}`)
  return { baseUrl: `http://127.0.0.1:${port}`, token }
}

export type GateApprovals = {
  /** Calls waiting for an approval (box-wide: the gate cannot tell which session asked). */
  pending(): Promise<ApprovalView[]>
  /** Approve (`once`) or refuse (`reject`) one pending approval. */
  decide(id: string, decision: "approve" | "deny"): Promise<ApprovalView>
}

export type GateOptions = { target: () => Promise<GateTarget>; invalidate?: () => void; fetch?: typeof fetch; timeoutMs?: number }

export function createGateApprovals(options: GateOptions): GateApprovals {
  const fetchFn = options.fetch ?? fetch
  const call = async (path: string, init: RequestInit = {}): Promise<{ status: number; data: unknown }> => {
    const target = await options.target()
    let res: Response
    try {
      res = await fetchFn(`${target.baseUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? GATE_TIMEOUT_MS),
        redirect: "error",
      })
    } catch {
      options.invalidate?.()
      throw unavailable("The delegation gate could not be reached.", "fetch failed")
    }
    if (res.status === 401) options.invalidate?.()
    return { status: res.status, data: await res.json().catch(() => undefined) }
  }
  return {
    async pending() {
      const { status, data } = await call("/v1/approvals?state=pending")
      const list = (data as { approvals?: unknown } | undefined)?.approvals
      if (status !== 200 || !Array.isArray(list)) throw unavailable("The delegation gate gave an unreadable approval list.", `HTTP ${status}`)
      return list as ApprovalView[]
    },
    async decide(id, decision) {
      if (!APPROVAL_ID_RE.test(id)) throw new DelegateError("invalid_input", "That is not an approval id (apr_...).", "Use an approval id from oc_pending.")
      const { status, data } = await call(`/v1/approvals/${id}`, { method: "POST", body: JSON.stringify({ decision }) })
      if (status === 409) throw new DelegateError("not_found", "That approval is not pending (already decided, used or expired).", "Call oc_pending again.", `HTTP ${status}`)
      const approval = (data as { approval?: ApprovalView } | undefined)?.approval
      if (status !== 200 || approval === undefined) throw unavailable("The delegation gate did not take the decision.", `HTTP ${status}`)
      return approval
    },
  }
}
