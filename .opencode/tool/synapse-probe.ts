/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import {
  fetchSynapseHealth,
  formatSynapseProbe,
  probeSynapseChat,
  redactSecrets,
  synapseKeyPresent,
  synapseKeySource,
  SYNAPSE_API_BASE,
  SYNAPSE_DASHBOARD_URL,
} from "./cas-bridge-lib"

export default tool({
  description: `Probe the Synapse AI gateway. Default live=true runs a tiny paid chat (~10–20 tokens) and reports x-synapse-served-model, rate limits, latency, usage. Pass live=false for free /health only. Requires SYNAPSE_API_KEY or GPAAS_API_KEY for live probes (not CAS OAuth; not SYNAPSE_MCP_BEARER_TOKEN).`,
  args: {
    live: tool.schema
      .boolean()
      .optional()
      .describe("If false, only hit /health (free). Default true = small paid chat completion for routing headers."),
    model: tool.schema
      .string()
      .optional()
      .describe('Model id or "auto" (default). Examples: auto, anthropic/claude-haiku-4.5'),
    prompt: tool.schema.string().optional().describe("Short probe prompt (default: Reply with exactly: pong)"),
    maxTokens: tool.schema.number().optional().describe("Max completion tokens (1–64, default 16)"),
    taskType: tool.schema.string().optional().describe("Optional x-task-type header (e.g. code, general)"),
    qualityTier: tool.schema
      .string()
      .optional()
      .describe("Optional x-quality-tier: economy | balanced | premium"),
    privacyTier: tool.schema
      .string()
      .optional()
      .describe("Optional x-privacy-tier: cloud-ok | local-only"),
  },
  async execute(args) {
    const live = args.live !== false

    if (!live) {
      try {
        const h = await fetchSynapseHealth()
        return [
          "Synapse health (free — no chat completion)",
          `• status: ${h.status ?? "?"}`,
          `• version: ${h.version ?? "?"} sha=${h.sha ?? "?"}`,
          `• label: ${h.label ?? h.environment ?? "?"}`,
          `• API: ${SYNAPSE_API_BASE}`,
          `• dashboard: ${SYNAPSE_DASHBOARD_URL}`,
          `• inference key for live probe: ${synapseKeySource() === "none" ? "missing" : "present via " + synapseKeySource()}`,
          "",
          "Pass live=true (default) for x-synapse-served-model + rate limits (small paid call).",
        ].join("\n")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return `synapse_probe health error: ${redactSecrets(message)}`
      }
    }

    if (!synapseKeyPresent()) {
      return [
        "synapse_probe: no Synapse inference API key for live chat.",
        "Set SYNAPSE_API_KEY or GPAAS_API_KEY (named gpaas_/gpapp_ PAT from Keystone / vault).",
        "CAS OAuth alone is not enough. SYNAPSE_MCP_BEARER_TOKEN is MCP-scoped and is not used for chat.",
        `Current key source: ${synapseKeySource()}`,
        "Tip: call with live=false for free /health only.",
      ].join("\n")
    }

    const quality = args.qualityTier?.trim()
    if (quality && !["economy", "balanced", "premium"].includes(quality)) {
      return "synapse_probe refused: qualityTier must be economy | balanced | premium"
    }
    const privacy = args.privacyTier?.trim()
    if (privacy && !["cloud-ok", "local-only"].includes(privacy)) {
      return "synapse_probe refused: privacyTier must be cloud-ok | local-only"
    }

    try {
      const result = await probeSynapseChat({
        model: args.model,
        prompt: args.prompt,
        maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : undefined,
        taskType: args.taskType,
        qualityTier: quality as "economy" | "balanced" | "premium" | undefined,
        privacyTier: privacy as "cloud-ok" | "local-only" | undefined,
      })
      return formatSynapseProbe(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `synapse_probe error: ${redactSecrets(message)}`
    }
  },
})
