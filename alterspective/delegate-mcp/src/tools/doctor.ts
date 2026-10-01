// oc_doctor (technical-design §5): read-only health of the sandbox and this bridge. It never
// starts the box (and never takes a lease) unless called with start:true; a box another bridge
// started is read through its status() target. Names and errors the box reports are box data.
import { z } from "zod"
import type { SupervisorStatus } from "../supervisor/status.ts"
import type { Verdict } from "../shared/contracts.ts"
import type { McpStatus, OpencodeApi } from "../shared/opencode-api.ts"
import { KS_NAME } from "../guard/entries.ts"
import { checkEgress, egressInput, type EgressCheck } from "../guard/egress-check.ts"
import { effectiveConfig } from "../shared/config.ts"
import type { ToolContext } from "./context.ts"
import { defineTool } from "./define.ts"
import { keystoneLine, keystoneReport, type KeystoneReport } from "./keystone-report.ts"
import { ok, untrusted } from "./shape.ts"

export const PROBE_DIRECTORY = "/sessions"
const ENTRY_NAME = /^[a-z0-9-]{1,67}$/
const STATUSES = new Set(["connected", "disabled", "needs_auth", "failed", "needs_client_registration"])

type McpReport = { entries: Array<{ name: string; status: string; error?: { text: string; truncated: boolean } }>; unrecognised: number } | { unavailable: string }

async function readMcp(api: OpencodeApi, correlationId: string): Promise<McpReport> {
  try {
    const res = await api.call<Record<string, McpStatus>>({ path: "/mcp", directory: PROBE_DIRECTORY, correlationId })
    if (res.status !== 200 || !res.data || typeof res.data !== "object") return { unavailable: `GET /mcp returned HTTP ${res.status}` }
    const entries: Extract<McpReport, { entries: unknown }>["entries"] = []
    let unrecognised = 0
    for (const [name, value] of Object.entries(res.data)) {
      const status = typeof value?.status === "string" && STATUSES.has(value.status) ? value.status : "unrecognised"
      if (!ENTRY_NAME.test(name)) {
        unrecognised++
        continue
      }
      const error = "error" in value && typeof value.error === "string" ? untrusted(value.error, 500) : undefined
      entries.push({ name, status, ...(error ? { error } : {}) })
    }
    return { entries, unrecognised }
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : "GET /mcp failed" }
  }
}

function boxReport(status: SupervisorStatus): Record<string, unknown> {
  if (status.state !== "running") return status.state === "stopped" ? { state: "stopped" } : { state: "unavailable", reason: status.reason }
  // Never the target itself: it carries the server password.
  return {
    state: "running",
    imageTag: status.imageTag,
    imageMatches: status.imageMatches,
    // The tag follows the build inputs, so a reused image can be older than the checkout: both shas are shown.
    imageBuiltFrom: status.imageBuiltFrom ?? "unknown",
    bridgeAt: status.bridgeAt ?? "unknown",
    policyVerified: status.policyVerified,
    frontMatches: status.frontMatches,
    health: status.health,
    startedBy: status.startedBy,
    baseUrl: status.target.baseUrl,
  }
}

function guardReport(verdict: Verdict): Record<string, unknown> {
  return verdict.ok ? { ok: true } : { ok: false, code: verdict.code, reason: untrusted(verdict.reason, 500) }
}

const ksEntries = (mcp: McpReport | undefined) => (mcp && "entries" in mcp ? mcp.entries.filter((e) => KS_NAME.test(e.name)) : [])

/** W3A-09: true only when every check ran and passed. */
export function isVerified(status: SupervisorStatus, mcp: McpReport | undefined, verdict: Verdict): boolean {
  if (status.state !== "running") return false
  // Every entry a Keystone one and signed in (or switched off): needs_auth / failed is not verified.
  const entriesOk = mcp !== undefined && "entries" in mcp && mcp.unrecognised === 0 && mcp.entries.every((e) => KS_NAME.test(e.name) && (e.status === "connected" || e.status === "disabled"))
  return status.imageMatches && status.policyVerified && status.frontMatches && status.health === "healthy" && entriesOk && verdict.ok
}

function notRunning(status: Exclude<SupervisorStatus, { state: "running" }>): string {
  if (status.state === "stopped") return "Sandbox stopped; nothing else checked. Call oc_doctor with start:true, or any session tool, to start it."
  return "Sandbox unavailable (Docker or the sandbox container could not be read); nothing else checked. Start Docker Desktop, check `docker ps` works, then call oc_doctor again."
}

/** Bridge words only: MCP entries are named only when they are ks-* entries (W3C-09); others are counted. */
function summaryOf(status: SupervisorStatus, mcp: McpReport | undefined, verdict: Verdict, verified: boolean): string {
  if (status.state !== "running") return notRunning(status)
  const built = `image built from ${status.imageBuiltFrom ?? "unknown"}, bridge at ${status.bridgeAt ?? "unknown"}`
  const checks = `Docker health ${status.health}, image ${status.imageMatches ? "ok" : "MISMATCH"} (${built}), policy ${status.policyVerified ? "ok" : "MISMATCH"}, front ${status.frontMatches ? "ok" : "MISMATCH"}`
  const ks = ksEntries(mcp)
  const others = mcp && "entries" in mcp ? mcp.entries.length - ks.length + mcp.unrecognised : 0
  const entries = mcp && "entries" in mcp ? `${ks.map((e) => `${e.name} ${e.status}`).join(", ") || "no Keystone entries"}${others ? `, ${others} other entr${others === 1 ? "y" : "ies"}` : ""}` : "MCP list unavailable"
  return `${verified ? "Verified" : "NOT verified"}: sandbox running (${checks}); ${entries}; guard ${verdict.ok ? "ok" : verdict.code}.`
}

/** R3-01: the egress control the sandbox files describe (configuration, not measured traffic). */
function egressReport(egress: EgressCheck): Record<string, unknown> {
  return { ...egress, problems: egress.problems.map((problem) => problem.slice(0, 300)) }
}

const egressSummary = (egress: EgressCheck) =>
  ` Egress: TLS front (fixed upstreams, no CONNECT proxy) ${egress.ok ? "configured as generated from egressHosts and the chosen Keystone set" : `MISMATCH (${egress.problems.length} problem${egress.problems.length === 1 ? "" : "s"})`}.`

/** The egress check for the Keystone set in force now; a damaged saved choice is a failed check, never a throw. */
function egressFor(ctx: ToolContext, keystone: KeystoneReport): EgressCheck {
  if ("unavailable" in keystone) {
    const failed = checkEgress(egressInput({ ...ctx.config, keystoneConnections: [] }))
    return { ...failed, ok: false, problems: [keystone.unavailable, ...failed.problems] }
  }
  return checkEgress(egressInput(effectiveConfig(ctx.config)))
}

/** Entry name → status from GET /mcp, for the Keystone report. */
const statusMap = (mcp: McpReport | undefined) => new Map(mcp && "entries" in mcp ? mcp.entries.map((e) => [e.name, e.status]) : [])

async function inspect(ctx: ToolContext, start: boolean, correlationId: string) {
  if (start && !ctx.peekBox()) await ctx.box()
  const status = await ctx.supervisorService.status()
  const held = ctx.peekBox()
  const api = held?.api ?? (status.state === "running" ? ctx.apiFor(status.target) : undefined)
  const mcp = api ? await readMcp(api, correlationId) : undefined
  const verdict: Verdict = api ? await ctx.guard.checkRuntime(api, PROBE_DIRECTORY) : { ok: false, code: "policy_unverified", reason: "the sandbox is not running" }
  return { status, mcp, verdict, held: held !== undefined }
}

export const doctorTool = defineTool({
  name: "oc_doctor",
  title: "Check the OpenCode sandbox",
  description:
    "Health check: sandbox state and Docker health, image, MCP-policy and front-config checks, the chosen Keystone services (`keystone`: the box-wide set, saved or default, and each entry's sign-in state), the policy guard verdict and this bridge's name and version, plus the configured egress allowlist, the egress control check (the TLS front generated from that allowlist and the Keystone set, no CONNECT proxy) and isolation level (configuration, not measured). `verified` is true only when every check ran and passed. Does not start the sandbox unless start is true.",
  input: { start: z.boolean().optional().describe("Start (or reuse) the sandbox first. Default false.") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const { status, mcp, verdict, held } = await inspect(ctx, args.start === true, correlationId)
    const keystone = keystoneReport(ctx.config, mcp && "entries" in mcp ? statusMap(mcp) : undefined)
    const egress = egressFor(ctx, keystone)
    const verified = isVerified(status, mcp, verdict) && egress.ok && !("unavailable" in keystone)
    return ok(`${summaryOf(status, mcp, verdict, verified)} ${keystoneLine(keystone)}.${egressSummary(egress)}`, {
      verified,
      bridge: { name: ctx.supervisor.replace(/^supervisor:/, ""), supervisor: ctx.supervisor, bridgeId: ctx.bridgeId, version: ctx.version, holdsBox: held, sessions: ctx.sessions.size },
      isolation: { level: "S", source: "configuration" },
      box: boxReport(status),
      mcp: mcp ?? { unavailable: "the sandbox is not running" },
      guard: guardReport(verdict),
      keystone,
      egressHostsConfigured: ctx.config.egressHosts,
      egress: egressReport(egress),
      keystoneOrigin: ctx.config.keystoneOrigin,
      roots: ctx.config.roots,
    })
  },
})
