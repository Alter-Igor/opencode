/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import { agentAllowlist, casTokenPresent, writeSelection } from "./cas-bridge-lib"

export default tool({
  description: `Select the preferred CAS agent for this project after the user picks one from the list. Saves agentId to .opencode/cas-selection.json. Later cas_safe_delegate can use this default when agentId is omitted (pass the selected id explicitly if unsure).`,
  args: {
    agentId: tool.schema.string().describe("CAS agent id (kebab-case) chosen by the user"),
    name: tool.schema.string().optional().describe("Display name from cas_list_agents"),
    description: tool.schema.string().optional().describe("Optional description"),
  },
  async execute(args, ctx) {
    if (!casTokenPresent()) {
      return "Not connected to CAS. Run: opencode mcp auth alterspective-agent — then cas_auth_status."
    }
    const agentId = args.agentId.trim()
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(agentId)) {
      return "cas_select_agent refused: agentId must be kebab-case"
    }
    const allow = agentAllowlist()
    if (!allow.includes(agentId)) {
      return `cas_select_agent refused: "${agentId}" not in allowlist (${allow.join(", ")}). Expand CAS_AGENT_ALLOWLIST if this is an intentional Foundry agent.`
    }
    writeSelection(ctx.directory, {
      agentId,
      name: args.name,
      description: args.description,
      selectedAt: new Date().toISOString(),
    })
    return [
      `Selected CAS agent: ${agentId}`,
      args.name ? `name: ${args.name}` : undefined,
      `Saved to .opencode/cas-selection.json under ${ctx.directory}`,
      "Next: cas_safe_delegate with this agentId and a short business task (no source dumps).",
    ]
      .filter(Boolean)
      .join("\n")
  },
})
