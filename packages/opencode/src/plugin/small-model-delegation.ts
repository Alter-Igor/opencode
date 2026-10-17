import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin"

export const DEFAULT_SMALL_MODEL_CONTEXT_THRESHOLD = 300000
export const RESTRICTED_TOOLS = new Set(["grep", "read"])

export function smallModelDelegationPrompt(limit?: number): string {
  const limitClause = limit ? ` (${limit} tokens)` : ""
  return [
    `CRITICAL CONTEXT LIMIT: Your active model has a small context window${limitClause}.`,
    "To prevent context overflow and degraded performance, you MUST delegate heavy exploration, multi-file reading, and wide searches to subagents using the task tool (e.g. subagent_type: 'explore').",
    "Do not read large files or run open-ended searches directly in this main session.",
    "Always instruct the subagent to return only a concise 3-5 bullet point summary of its findings.",
  ].join(" ")
}

export function toolRestrictedMessage(tool: string): string {
  return [
    `Context limit protection: Direct "${tool}" is restricted in the main session for this model to conserve context.`,
    `You MUST call the task tool with subagent_type: 'explore' to search or inspect files.`,
    `Example: { "subagent_type": "explore", "description": "Search codebase", "prompt": "Find target code and return file:line citations and a short summary." }`,
  ].join(" ")
}

export function parseThreshold(envValue?: string, configValue?: unknown): number {
  if (envValue !== undefined) {
    const parsed = Number.parseInt(envValue, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  if (typeof configValue === "number" && !Number.isNaN(configValue)) {
    return configValue
  }
  return DEFAULT_SMALL_MODEL_CONTEXT_THRESHOLD
}

export async function SmallModelDelegationPlugin(_input: PluginInput): Promise<Hooks> {
  let configuredThreshold: number | undefined
  const activeSessions = new Set<string>()

  return {
    config: async (cfg: Config) => {
      const experimental = (cfg as Record<string, unknown>)["experimental"] as Record<string, unknown> | undefined
      const candidate =
        experimental?.["small_model_threshold"] ??
        experimental?.["small_model_context_threshold"] ??
        (cfg as Record<string, unknown>)["small_model_context_threshold"]
      if (typeof candidate === "number" && !Number.isNaN(candidate)) {
        configuredThreshold = candidate
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      // Session turns only; skip outside a live session or if running inside a subagent session
      if (!input.sessionID) return
      if (input.parentSessionID || (input.agent && input.agent !== "build")) {
        activeSessions.delete(input.sessionID)
        return
      }

      const delegationEnv = process.env["OPENCODE_SMALL_MODEL_DELEGATION"]?.trim().toLowerCase()
      if (delegationEnv === "0" || delegationEnv === "false") {
        activeSessions.delete(input.sessionID)
        return
      }

      const threshold = parseThreshold(process.env["OPENCODE_SMALL_MODEL_THRESHOLD"], configuredThreshold)
      const contextLimit = input.model?.limit?.context

      const forceActive = delegationEnv === "1" || delegationEnv === "true"
      const limitActive = Boolean(contextLimit && contextLimit > 0 && contextLimit <= threshold)

      if (!forceActive && !limitActive) {
        activeSessions.delete(input.sessionID)
        return
      }

      activeSessions.add(input.sessionID)
      output.system.push(smallModelDelegationPrompt(contextLimit))
    },
    "tool.execute.before": async (input) => {
      if (!activeSessions.has(input.sessionID)) return
      if (!RESTRICTED_TOOLS.has(input.tool)) return

      throw new Error(toolRestrictedMessage(input.tool))
    },
  }
}
