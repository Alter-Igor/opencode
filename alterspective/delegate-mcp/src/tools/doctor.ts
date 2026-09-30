// oc_doctor (technical-design §5): read-only health of the sandbox and this bridge. It never
// starts the box (and never takes a lease) unless called with start:true; a box another bridge
// started is read through its status() target. Names and errors the box reports are box data.
import { z } from "zod"
import type { SupervisorStatus } from "../supervisor/status.ts"
import type { Verdict } from "../shared/contracts.ts"
import type { McpStatus, OpencodeApi } from "../shared/opencode-api.ts"
import type { ToolContext } from "./context.ts"
import { defineTool } from "./define.ts"
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
    policyVerified: status.policyVerified,
    health: status.health,
    startedBy: status.startedBy,
    baseUrl: status.target.baseUrl,
  }
}

function guardReport(verdict: Verdict): Record<string, unknown> {
  return verdict.ok ? { ok: true } : { ok: false, code: verdict.code, reason: untrusted(verdict.reason, 500) }
}

function summaryOf(status: SupervisorStatus, mcp: McpReport | undefined, verdict: Verdict): string {
  if (status.state !== "running") return `Sandbox ${status.state}; nothing else checked. Call oc_doctor with start:true, or any session tool, to start it.`
  const checks = `image ${status.imageMatches ? "ok" : "MISMATCH"}, policy ${status.policyVerified ? "ok" : "MISMATCH"}`
  const entries = mcp && "entries" in mcp ? mcp.entries.map((e) => `${e.name} ${e.status}`).join(", ") || "no MCP entries" : "MCP list unavailable"
  return `Sandbox running (${checks}); ${entries}; guard ${verdict.ok ? "ok" : verdict.code}.`
}

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
    "Read-only health check: sandbox state, image and MCP-policy checks, the Keystone MCP entries and their sign-in state, the egress allowlist, the policy guard verdict and this bridge's name and version. Does not start the sandbox unless start is true.",
  input: { start: z.boolean().optional().describe("Start (or reuse) the sandbox first. Default false.") },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const { status, mcp, verdict, held } = await inspect(ctx, args.start === true, correlationId)
    return ok(summaryOf(status, mcp, verdict), {
      bridge: { name: ctx.supervisor.replace(/^supervisor:/, ""), supervisor: ctx.supervisor, bridgeId: ctx.bridgeId, version: ctx.version, holdsBox: held, sessions: ctx.sessions.size },
      isolation: "S",
      box: boxReport(status),
      mcp: mcp ?? { unavailable: "the sandbox is not running" },
      guard: guardReport(verdict),
      egressHosts: ctx.config.egressHosts,
      keystoneOrigin: ctx.config.keystoneOrigin,
      roots: ctx.config.roots,
    })
  },
})
