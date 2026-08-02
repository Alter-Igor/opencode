/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import {
  formatSynapseProbe,
  probeSynapseChat,
  redactSecrets,
  synapseKeyPresent,
  synapseKeySource,
} from "./cas-bridge-lib"

export default tool({
  description: `Probe the Synapse AI gateway (synapse2-api) with a tiny chat completion and report how it processed the request: x-synapse-served-model, rate-limit remaining/limit, latency, token usage, optional routing headers. Requires SYNAPSE_API_KEY or GPAAS_API_KEY. model=auto shows local-vs-cloud routing; pin a model id to verify pins.`,
  args: {
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
    if (!synapseKeyPresent()) {
      return [
        "synapse_probe: no Synapse API key.",
        "Set SYNAPSE_API_KEY or GPAAS_API_KEY (named gpaas_/gpapp_ PAT from Keystone / vault).",
        "CAS OAuth alone is not enough — Synapse uses a different credential than agent.alterspective.com.au.",
        `Current key source: ${synapseKeySource()}`,
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
