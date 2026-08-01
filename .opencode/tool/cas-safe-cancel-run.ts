/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import { callCasMcpTool, casTokenPresent, wrapUntrusted } from "./cas-bridge-lib"

export default tool({
  description: `Cancel an in-flight CAS run by id. Fails closed without CAS_MCP_TOKEN.`,
  args: {
    runId: tool.schema.string().describe("CAS run id"),
  },
  async execute(args) {
    if (!casTokenPresent()) {
      return "CAS bridge degraded: CAS_MCP_TOKEN is not set."
    }
    const runId = args.runId.trim()
    if (!runId || runId.length > 128) return "cas_safe_cancel_run refused: invalid runId"
    try {
      const result = await callCasMcpTool("cas_cancel_run", { runId })
      return wrapUntrusted("cas_cancel_run", result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `cas_safe_cancel_run error: ${message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")}`
    }
  },
})
