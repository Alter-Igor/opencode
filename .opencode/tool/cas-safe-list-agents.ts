/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import { callCasMcpTool, casTokenPresent, notConnectedMessage, redactSecrets, wrapUntrusted } from "./cas-bridge-lib"

export default tool({
  description: `List CAS agents invocable by the signed-in principal (org-active + own personal). Use before cas_safe_delegate to pick agentId. Requires CAS OAuth or optional CAS_MCP_TOKEN.`,
  args: {},
  async execute() {
    if (!casTokenPresent()) {
      return notConnectedMessage("Then cas_auth_status / cas_safe_list_agents.")
    }
    try {
      const result = await callCasMcpTool("cas_list_agents", {})
      return wrapUntrusted("cas_list_agents", result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `cas_safe_list_agents error: ${redactSecrets(message)}`
    }
  },
})
