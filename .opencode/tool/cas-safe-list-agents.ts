/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import { callCasMcpTool, casTokenPresent, wrapUntrusted } from "./cas-bridge-lib"

export default tool({
  description: `List CAS agents invocable by the current CAS_MCP_TOKEN principal (org-active + own personal). Use before cas_safe_delegate to pick agentId. Fails closed when CAS_MCP_TOKEN is missing.`,
  args: {},
  async execute() {
    if (!casTokenPresent()) {
      return "CAS bridge degraded: CAS_MCP_TOKEN is not set. Cannot list agents. Set a CAS MCP bearer (user env) and retry."
    }
    try {
      const result = await callCasMcpTool("cas_list_agents", {})
      return wrapUntrusted("cas_list_agents", result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `cas_safe_list_agents error: ${message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")}`
    }
  },
})
