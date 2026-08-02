/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import {
  callCasMcpTool,
  casTokenPresent,
  formatRunInsights,
  notConnectedMessage,
  parseCasRunPayload,
  redactSecrets,
  wrapUntrusted,
} from "./cas-bridge-lib"

export default tool({
  description: `Raw CAS run JSON by id (after cas_safe_delegate with background=true). Prefer cas_safe_run_insights for human-readable status/tokens/correlationId; use this only when you need the full unformatted payload.`,
  args: {
    runId: tool.schema.string().describe("CAS run id"),
  },
  async execute(args) {
    if (!casTokenPresent()) return notConnectedMessage()
    const runId = args.runId.trim()
    if (!runId || runId.length > 128) return "cas_safe_get_run refused: invalid runId"
    try {
      const result = await callCasMcpTool("cas_get_run", { runId })
      const run = parseCasRunPayload(result)
      if (run) {
        return (
          formatRunInsights(run) +
          "\n\n(Tip: cas_safe_run_insights is the preferred observability tool; raw JSON below if needed.)\n\n" +
          wrapUntrusted("cas_get_run", result)
        )
      }
      return wrapUntrusted("cas_get_run", result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `cas_safe_get_run error: ${redactSecrets(message)}`
    }
  },
})
