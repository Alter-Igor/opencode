/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import { casAuthSource, casTokenPresent, mcpAuthPath, readSelection } from "./cas-bridge-lib"

export default tool({
  description: `Check CAS (agent.alterspective.com.au) connection status: OAuth/env token, preferred agent selection. Tell the user how to connect if not authenticated.`,
  args: {},
  async execute(_args, ctx) {
    const source = casAuthSource()
    const selected = readSelection(ctx.directory)
    const lines = [
      "CAS connection status",
      `• authenticated: ${casTokenPresent() ? "yes" : "no"}`,
      `• credential source: ${source}`,
      `• OAuth store: ${mcpAuthPath()}`,
      selected
        ? `• selected agent: ${selected.agentId}${selected.name ? ` (${selected.name})` : ""} @ ${selected.selectedAt}`
        : "• selected agent: (none — use cas_select_agent after listing)",
      "",
      source === "none"
        ? [
            "Not connected. Connect with OAuth (recommended):",
            "  opencode mcp auth alterspective-agent",
            "That opens a browser login, stores tokens under OpenCode MCP auth, then restart the session.",
            "Optional override: set env CAS_MCP_TOKEN to a bearer (not preferred).",
          ].join("\n")
        : source === "oauth"
          ? "Connected via OpenCode MCP OAuth. Use cas_list_agents (or cas_safe_list_agents) then cas_select_agent."
          : "Connected via CAS_MCP_TOKEN env. Prefer OAuth: opencode mcp auth alterspective-agent",
    ]
    return lines.join("\n")
  },
})
