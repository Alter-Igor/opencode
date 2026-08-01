/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import { callCasMcpTool, casTokenPresent, validateDelegate, wrapUntrusted } from "./cas-bridge-lib"

export default tool({
  description: `Safely delegate a short business task to a CAS specialised agent (agent.alterspective.com.au). Enforces agent allowlist, size caps, and rejects secret/source-code-looking payloads. Prefer this over raw cas_delegate. Pass background=true for long work (poll with cas_safe_get_run).`,
  args: {
    agentId: tool.schema.string().describe("CAS agent id (kebab-case), e.g. drafter, matter-audit"),
    task: tool.schema.string().describe("Self-contained instruction for the agent (no repo dumps)"),
    context: tool.schema.string().optional().describe("Optional short supporting context (not full chat history)"),
    background: tool.schema.boolean().optional().describe("If true, enqueue and return run handle immediately"),
  },
  async execute(args) {
    if (!casTokenPresent()) {
      return "CAS bridge degraded: CAS_MCP_TOKEN is not set. Cannot delegate. Set a CAS MCP bearer and retry."
    }

    const checked = validateDelegate({
      agentId: args.agentId,
      task: args.task,
      context: args.context,
    })
    if (!checked.ok) return `cas_safe_delegate refused: ${checked.reason}`

    const mcpArgs: Record<string, unknown> = {
      agentId: checked.agentId,
      task: checked.task,
    }
    if (checked.context) mcpArgs.context = checked.context
    if (args.background === true) mcpArgs.background = true

    try {
      const result = await callCasMcpTool("cas_delegate", mcpArgs)
      return wrapUntrusted("cas_delegate", result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Never echo token material
      return `cas_safe_delegate error: ${message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")}`
    }
  },
})
