/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import {
  callCasMcpTool,
  casTokenPresent,
  readSelection,
  validateDelegate,
  wrapUntrusted,
} from "./cas-bridge-lib"

export default tool({
  description: `Safely delegate a short business task to a CAS specialised agent (agent.alterspective.com.au). Enforces agent allowlist, size caps, and rejects secret/source-code-looking payloads. Prefer this over raw cas_delegate. Pass background=true for long work (poll with cas_safe_get_run).`,
  args: {
    agentId: tool.schema
      .string()
      .optional()
      .describe("CAS agent id (kebab-case). Omit to use .opencode/cas-selection.json from cas_select_agent."),
    task: tool.schema.string().describe("Self-contained instruction for the agent (no repo dumps)"),
    context: tool.schema.string().optional().describe("Optional short supporting context (not full chat history)"),
    background: tool.schema.boolean().optional().describe("If true, enqueue and return run handle immediately"),
  },
  async execute(args, ctx) {
    if (!casTokenPresent()) {
      return "Not connected to CAS. Run: opencode mcp auth alterspective-agent — then retry."
    }

    const selected = readSelection(ctx.directory)
    const agentId = (args.agentId?.trim() || selected?.agentId || "").trim()
    if (!agentId) {
      return "No agentId provided and no cas_select_agent selection. Run cas_safe_list_agents, ask the user to pick, then cas_select_agent."
    }

    const checked = validateDelegate({
      agentId,
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
