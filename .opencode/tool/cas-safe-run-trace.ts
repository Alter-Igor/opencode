/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import {
  callCasRest,
  casTokenPresent,
  formatRunTrace,
  redactSecrets,
  wrapUntrusted,
  MAX_RESPONSE_CHARS,
} from "./cas-bridge-lib"

export default tool({
  description: `Fetch the durable CAS end-to-end run trace (GET /api/v1/runs/:id/trace): prompt → tool selection → tool calls/results → response. User-scoped (not admin). Shows how CAS processed the request; pair with synapse_probe for gateway routing.`,
  args: {
    runId: tool.schema.string().describe("CAS run id"),
  },
  async execute(args) {
    if (!casTokenPresent()) {
      return "Not connected to CAS. Run: opencode mcp auth alterspective-agent — then retry."
    }
    const runId = args.runId.trim()
    if (!runId || runId.length > 128) return "cas_safe_run_trace refused: invalid runId"

    try {
      const payload = await callCasRest(`/api/v1/runs/${encodeURIComponent(runId)}/trace`)
      const formatted = formatRunTrace(payload)
      if (formatted.length > MAX_RESPONSE_CHARS) {
        return wrapUntrusted(
          "cas_run_trace",
          formatted.slice(0, MAX_RESPONSE_CHARS) +
            `\n…[truncated ${formatted.length - MAX_RESPONSE_CHARS} chars]`,
        )
      }
      return wrapUntrusted("cas_run_trace", formatted)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `cas_safe_run_trace error: ${redactSecrets(message)}`
    }
  },
})
