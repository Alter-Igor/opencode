/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import {
  callCasMcpTool,
  casTokenPresent,
  formatRunList,
  notConnectedMessage,
  parseCasRunListPayload,
  redactSecrets,
  wrapUntrusted,
  RUN_STATUSES,
} from "./cas-bridge-lib"

export default tool({
  description: `List recent CAS runs for the signed-in principal (status, agent, turns, token totals). Use after cas_safe_delegate or to discover runIds for cas_safe_run_insights / cas_safe_run_trace.`,
  args: {
    status: tool.schema
      .string()
      .optional()
      .describe(`Optional filter: ${RUN_STATUSES.join(" | ")}`),
    sessionId: tool.schema.string().optional().describe("Optional session id filter"),
    limit: tool.schema.number().optional().describe("Max rows (1–100, default 20)"),
  },
  async execute(args) {
    if (!casTokenPresent()) return notConnectedMessage()

    const status = args.status?.trim()
    if (status && !(RUN_STATUSES as readonly string[]).includes(status)) {
      return `cas_safe_list_runs refused: status must be one of ${RUN_STATUSES.join(", ")}`
    }

    const limitRaw = args.limit
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw)
        ? Math.min(100, Math.max(1, Math.floor(limitRaw)))
        : 20

    const mcpArgs: Record<string, unknown> = { limit }
    if (status) mcpArgs.status = status
    if (args.sessionId?.trim()) mcpArgs.sessionId = args.sessionId.trim()

    try {
      const result = await callCasMcpTool("cas_list_runs", mcpArgs)
      const runs = parseCasRunListPayload(result)
      if (runs.length) return formatRunList(runs)
      return wrapUntrusted("cas_list_runs", result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `cas_safe_list_runs error: ${redactSecrets(message)}`
    }
  },
})
