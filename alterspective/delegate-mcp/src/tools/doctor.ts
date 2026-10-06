// oc_doctor (technical-design §5): read-only health of the sandbox and this bridge. It never
// starts the box (and never takes a lease) unless called with start:true; a box another bridge
// started is read through its status() target. Names and errors the box reports are box data.
import { z } from "zod"
import type { LiveChecks } from "../supervisor/live.ts"
import type { SupervisorStatus } from "../supervisor/status.ts"
import type { Verdict } from "../shared/contracts.ts"
import type { McpStatus, OpencodeApi } from "../shared/opencode-api.ts"
import { KS_NAME } from "../guard/entries.ts"
import { checkEgress, egressInput, type EgressCheck } from "../guard/egress-check.ts"
import { currentKeystone, effectiveConfig } from "../shared/config.ts"
import { DYNAMIC_ID, readKeystoneSet } from "../shared/keystone.ts"
import { ceilingOf } from "../shared/keystone-policy.ts"
import { reconnectTick } from "../keystone-auth/host-wiring.ts"
import type { ToolContext } from "./context.ts"
import { defineTool } from "./define.ts"
import { keystoneLine, keystoneReport, type KeystoneReport } from "./keystone-report.ts"
import { ok, untrusted } from "./shape.ts"
import type { SynapseReport } from "../synapse/index.ts"
import { keystoneAuthLine, keystoneAuthReport } from "./keystone-auth-report.ts"

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

/**
 * Review L6: every CHOSEN Keystone connection must be listed by GET /mcp and be signed in or switched
 * off. A chosen entry the box does not list (`missing`) is not verified.
 */
export const keystoneEntriesOk = (keystone: KeystoneReport) =>
  !("unavailable" in keystone) && keystone.entries !== undefined && keystone.entries.every((e) => e.status === "connected" || e.status === "disabled")

/** The id of the owner's private read-only RAG connection in the default set (issue #56, review L7). */
const OWNER_RAG_READ = "rag-read"

/**
 * Review L7: `rag-read` is the owner's private Keystone connection id. When it is missing or not
 * signed in, say so, and how anyone else uses their own connection over the same service.
 */
export function keystoneEntriesHint(keystone: KeystoneReport, hostAuth = false): string {
  if ("unavailable" in keystone) return ""
  const notReady = (keystone.entries ?? []).filter((e) => e.status !== "connected" && e.status !== "disabled")
  if (notReady.length === 0) return ""
  const list = ` Chosen Keystone entries not ready: ${notReady.map((e) => `${e.name} ${e.status}`).join(", ")}.`
  const entry = notReady.find((e) => e.id === OWNER_RAG_READ)
  if (!entry) return `${list} ${hostAuth ? "Run oc_login: it reconnects entries whose host token is valid and signs in the rest." : "Run oc_login for them."}`
  return `${list} \`${OWNER_RAG_READ}\` is the owner's private Keystone connection id. If you are the owner, run oc_login {server: "ks-${OWNER_RAG_READ}"}. Anyone else creates their own connection over the Keystone service \`rag-read\` and sets its id in OPENCODE_DELEGATE_KEYSTONE and OPENCODE_DELEGATE_KEYSTONE_ALLOWED (README "Keystone services").`
}

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
  if ("unavailable" in keystone || keystone.problem) {
    const failed = checkEgress(egressInput({ ...ctx.config, keystoneConnections: [] }))
    const reason = "unavailable" in keystone ? keystone.unavailable : keystone.problem!
    return { ...failed, ok: false, problems: [reason, ...failed.problems] }
  }
  try {
    return checkEgress(egressInput(effectiveConfig(ctx.config)))
  } catch (error) {
    const failed = checkEgress(egressInput({ ...ctx.config, keystoneConnections: [] }))
    return { ...failed, ok: false, problems: [error instanceof Error ? error.message : "Keystone config error", ...failed.problems] }
  }
}

/** Entry name → status from GET /mcp, for the Keystone report. */
const statusMap = (mcp: McpReport | undefined) => new Map(mcp && "entries" in mcp ? mcp.entries.map((e) => [e.name, e.status]) : [])

async function inspect(ctx: ToolContext, start: boolean, correlationId: string) {
  if (start && !ctx.peekBox()) await ctx.box()
  const status = await ctx.supervisorService.status()
  const held = ctx.peekBox()
  const api = held?.api ?? (status.state === "running" ? ctx.apiFor(status.target) : undefined)
  // Review M1: with host-held tokens, reconnect signed-in entries on the box read here (held by any
  // bridge) before reporting them: OpenCode does not reconnect an oauth:false entry by itself.
  const keystone = ctx.keystone
  if (api && keystone) {
    const safeConnections = () => {
      try {
        return currentKeystone(ctx.config).connections
      } catch {
        try {
          const saved = readKeystoneSet(ctx.config.home, ctx.config.keystoneConnections)
          const ceiling = ceilingOf(ctx.config)
          return saved.connections.filter((c) => ceiling.includes(c))
        } catch {
          return []
        }
      }
    }
    await reconnectTick(() => api, (ids) => keystone.status(ids), safeConnections, ctx.log)
  }
  const mcp = api ? await readMcp(api, correlationId) : undefined
  const verdict: Verdict = api ? await ctx.guard.checkRuntime(api, PROBE_DIRECTORY) : { ok: false, code: "policy_unverified", reason: "the sandbox is not running" }
  // R5-01 / R5-05: what is running, not what the labels say.
  const live = status.state === "running" ? await ctx.supervisorService.verifyLive() : undefined
  return { status, mcp, verdict, live, held: held !== undefined }
}

/** Live checks in one sentence, with each failure's reason, and earlier removals the owner should revoke. */
function liveSummary(live: LiveChecks | undefined, hostAuth: boolean): string {
  if (!live) return ""
  const stored = hostAuth ? "the box stores no sign-in (host-held Keystone tokens)" : "stored sign-ins only for the chosen set"
  const state = live.ok ? ` Live: ${stored}; front runs the generated config with its folder read-only.` : ` Live checks FAILED: ${live.problems.join("; ").slice(0, 600)}.`
  const removed = live.signIns.removedBefore
  if (removed.length === 0) return state
  const list = removed.slice(-10).map((entry) => `${entry.name}${entry.clientId ? ` (client ${entry.clientId})` : ""}`).join(", ")
  return `${state} Removed earlier from the box (Keystone cannot revoke them for the bridge; revoke by client id in Keystone if not done): ${list}.`
}

/** WS2 (#48): the owner's Synapse token, by state only (never a value). */
function liveWords(live: Exclude<SynapseReport["live"], { unavailable: string }>): string {
  const problems = [
    ...(live.shapeOk && live.hasToken ? [] : ["front's loaded include is NOT the expected one-variable file with a token"]),
    ...(live.matchesHost ? [] : ["front loaded a different include than this bridge home's (another home?)"]),
    ...(live.routesOk ? [] : ["front's synapse routes are NOT the allowed model routes"]),
  ]
  return problems.length === 0 ? "front has it loaded, model routes only" : problems.join("; ")
}

export function synapseLine(report: SynapseReport): string {
  if (report.state === "needs_sign_in") return ` Synapse: NEEDS SIGN-IN (no model calls until then; run oc_login {server: "synapse"})${report.lastError ? `; last error: ${report.lastError}` : ""}.`
  if (report.state === "include_empty")
    return ` Synapse: signed in${report.user ? ` as ${report.user}` : ""}, but front's include has NO token (it was re-created or emptied); no model calls until the bridge writes it again on its next renewal tick (every 15 s)${report.lastError ? `; last error: ${report.lastError}` : ""}. If it lasts, run oc_login {server: "synapse"}.`
  if (report.state === "expired")
    return ` Synapse: token EXPIRED at ${report.expiresAt ?? "unknown"}; no model calls until a renewal works. The bridge keeps retrying${report.nextRetryAt ? ` (next ${report.nextRetryAt})` : ""}${report.lastError ? `; last error: ${report.lastError}` : ""}. If it lasts, run oc_login {server: "synapse"}.`
  const live = "unavailable" in report.live ? `front: ${report.live.unavailable}` : liveWords(report.live)
  // Review M3: `nginx -T` shows the files nginx WOULD load; this says whether it reloaded since the write.
  const loaded = report.loadedSinceWrite ? "" : `; front has NOT loaded the include written last (last reload: ${report.lastReload ? `${report.lastReload.result} at ${report.lastReload.at}` : "none recorded"}; restart the sandbox if it lasts)`
  return ` Synapse: signed in${report.user ? ` as ${report.user}` : ""}${report.actor ? ` via ${report.actor}` : ""}, token until ${report.expiresAt}, renews from ${report.refreshAt}; ${live}${loaded}.`
}

/**
 * #104: the delegation gate, when the dynamic connection is chosen. Its admin API must answer with
 * the per-start token; the waiting approvals are counted (never their content). Not chosen: not checked.
 */
async function gateReport(ctx: ToolContext, connections: readonly string[], running: boolean): Promise<{ ok: boolean; line: string; report: Record<string, unknown> }> {
  if (!connections.includes(DYNAMIC_ID)) return { ok: true, line: "", report: { used: false } }
  const profile = ctx.config.dynamicProfile === "" ? "default (every tool; risky tools wait for approval)" : "custom (OPENCODE_DELEGATE_DYNAMIC_PROFILE)"
  if (!running || ctx.gate === undefined) return { ok: false, line: " Delegation gate: not checked (the sandbox is not running).", report: { used: true, profile, reachable: false } }
  try {
    const waiting = (await ctx.gate.pending()).length
    return { ok: true, line: ` Delegation gate: ok, profile ${profile}, ${waiting} call(s) waiting for approval.`, report: { used: true, profile, reachable: true, waitingApprovals: waiting } }
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 200) : "unreachable"
    return { ok: false, line: ` Delegation gate: NOT reachable (${reason}).`, report: { used: true, profile, reachable: false, reason } }
  }
}

export const doctorTool = defineTool({
  name: "oc_doctor",
  title: "Check the OpenCode sandbox",
  description:
    "Health check: sandbox state and Docker health, image, MCP-policy and front-config checks, the chosen Keystone services (`keystone`: the box-wide set, saved or default, each entry's sign-in state, the owner's allowed list `ceiling` and high-risk `warnings`), live checks (`live`: sign-ins stored in the box are only for the chosen set, front's loaded config and mount modes; entries removed earlier), the owner's Synapse token (`synapse`: signed_in / include_empty / expired / needs_sign_in, expiry and renewal time, refresh token stored on the host, front's loaded auth include has the strict shape, and the last reload result and whether front loaded the include written last; never a value), the host-held Keystone tokens when OCD_KEYSTONE_HOST_AUTH=1 (`keystoneAuth`: per chosen connection signed in, expiry, needs sign-in, and whether front's loaded include has the strict shape and a token; front's listed ids against the chosen ids; the box's sign-in store is empty; never a value), the policy guard verdict and this bridge's name and version, plus the configured egress allowlist, the egress control check (the TLS front generated from that allowlist and the Keystone set, no CONNECT proxy) and isolation level (configuration, not measured). `verified` is true only when every check ran and passed. Does not start the sandbox unless start is true.",
  input: { start: z.boolean().optional().describe("Start (or reuse) the sandbox first. Default false.") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const { status, mcp, verdict, live, held } = await inspect(ctx, args.start === true, correlationId)
    const keystone = keystoneReport(ctx.config, mcp && "entries" in mcp ? statusMap(mcp) : undefined)
    const egress = egressFor(ctx, keystone)
    const synapse = await ctx.synapse.status()
    const keystoneAuth = await keystoneAuthReport(ctx, keystone, live)
    const gate = await gateReport(ctx, "connections" in keystone ? keystone.connections : [], status.state === "running")
    const verified = isVerified(status, mcp, verdict) && egress.ok && keystoneEntriesOk(keystone) && live?.ok === true && synapse.ok && (!keystoneAuth.enabled || keystoneAuth.ok) && gate.ok
    return ok(`${summaryOf(status, mcp, verdict, verified)} ${keystoneLine(keystone)}.${keystoneEntriesHint(keystone, ctx.keystone !== undefined)}${egressSummary(egress)}${liveSummary(live, keystoneAuth.enabled)}${synapseLine(synapse)}${keystoneAuthLine(keystoneAuth)}${gate.line}`, {
      verified,
      synapse,
      keystoneAuth,
      gate: gate.report,
      bridge: { name: ctx.supervisor.replace(/^supervisor:/, ""), supervisor: ctx.supervisor, bridgeId: ctx.bridgeId, version: ctx.version, holdsBox: held, sessions: ctx.sessions.size },
      isolation: { level: "S", source: "configuration" },
      box: boxReport(status),
      mcp: mcp ?? { unavailable: "the sandbox is not running" },
      guard: guardReport(verdict),
      live: live ?? { unavailable: "the sandbox is not running" },
      keystone,
      egressHostsConfigured: ctx.config.egressHosts,
      egress: egressReport(egress),
      keystoneOrigin: ctx.config.keystoneOrigin,
      roots: ctx.config.roots,
    })
  },
})
