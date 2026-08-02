/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import { callCasMcpTool, casTokenPresent, notConnectedMessage, redactSecrets, wrapUntrusted } from "./cas-bridge-lib"

export default tool({
  description: `Cancel an in-flight CAS run by id. Requires CAS OAuth (opencode mcp auth alterspective-agent) or optional CAS_MCP_TOKEN.`,
  args: {
    runId: tool.schema.string().describe("CAS run id"),
  },
  async execute(args) {
    if (!casTokenPresent()) return notConnectedMessage()
    const runId = args.runId.trim()
    if (!runId || runId.length > 128) return "cas_safe_cancel_run refused: invalid runId"
    try {
      const result = await callCasMcpTool("cas_cancel_run", { runId })
      return wrapUntrusted("cas_cancel_run", result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `cas_safe_cancel_run error: ${redactSecrets(message)}`
    }
  },
})
