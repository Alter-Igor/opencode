/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import {
  casAuthSource,
  fetchCasHealth,
  fetchSynapseHealth,
  formatPipelineStatus,
  redactSecrets,
  synapseKeySource,
} from "./cas-bridge-lib"

export default tool({
  description: `Show OpenCode → CAS → Synapse pipeline health: CAS version/gateway model/Langfuse, Synapse API health, and whether your CAS OAuth + Synapse API keys are present. No secrets returned. Use before debugging slow/failed agent runs.`,
  args: {},
  async execute() {
    let cas
    let casError
    try {
      cas = await fetchCasHealth()
    } catch (err) {
      casError = err instanceof Error ? err.message : String(err)
    }

    let synapse
    let synapseError
    try {
      synapse = await fetchSynapseHealth()
    } catch (err) {
      synapseError = err instanceof Error ? err.message : String(err)
    }

    const casAuth = casAuthSource()
    const synAuth = synapseKeySource()

    try {
      return formatPipelineStatus({
        cas,
        casError: casError ? redactSecrets(casError) : undefined,
        synapse,
        synapseError: synapseError ? redactSecrets(synapseError) : undefined,
        casAuth:
          casAuth === "none"
            ? "not connected (opencode mcp auth alterspective-agent)"
            : casAuth === "oauth"
              ? "oauth (mcp-auth.json)"
              : "env CAS_MCP_TOKEN",
        synapseAuth:
          synAuth === "none"
            ? "missing (set SYNAPSE_API_KEY or GPAAS_API_KEY for synapse_probe)"
            : `present via ${synAuth}`,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `cas_pipeline_status error: ${redactSecrets(message)}`
    }
  },
})
