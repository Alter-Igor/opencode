/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import {
  callCasMcpTool,
  casTokenPresent,
  formatRunInsights,
  parseCasRunPayload,
  redactSecrets,
  wrapUntrusted,
} from "./cas-bridge-lib"

export default tool({
  description: `Human-readable insights for a CAS run: status, agent/template, loop turns, Synapse token spend (prompt/completion), wall time, correlationId (Langfuse/logs), children. Prefer over raw cas_get_run for observability. Pass includeRaw=true for full JSON.`,
  args: {
    runId: tool.schema.string().describe("CAS run id (from cas_safe_delegate background handle or cas_safe_list_runs)"),
    includeRaw: tool.schema.boolean().optional().describe("If true, append full run JSON under the summary"),
  },
  async execute(args) {
    if (!casTokenPresent()) {
      return "Not connected to CAS. Run: opencode mcp auth alterspective-agent — then retry."
    }
    const runId = args.runId.trim()
    if (!runId || runId.length > 128) return "cas_safe_run_insights refused: invalid runId"

    try {
      const result = await callCasMcpTool("cas_get_run", { runId })
      const run = parseCasRunPayload(result)
      if (run) return formatRunInsights(run, { includeRaw: args.includeRaw === true })
      return wrapUntrusted("cas_get_run", result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `cas_safe_run_insights error: ${redactSecrets(message)}`
    }
  },
})
