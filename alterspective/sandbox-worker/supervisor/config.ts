// The managed OpenCode config the supervisor writes (FEAT-CAS-012, fork #47).
// Pure: no I/O, so it can be tested without a container.

export type Manifest = {
  taskId: string
  /** Where Synapse calls go. The model ids are not here: they come from the policy (#102). */
  model: {
    baseURL: string
    headers?: Record<string, string>
    /**
     * #102: the service's configured on-prem default model ids (strongest last), used only when
     * `modelPolicy` is missing or unusable. Absent too ⇒ Synapse `auto`. Always local-only (#101).
     */
    onPremDefault?: string[]
  }
  /**
   * #102: the CAS AI-roles resolve answer for this task (`{ cell, effectivePolicyVersion }`), resolved
   * and frozen by svc-coding-agent and passed through verbatim. Absent or unusable ⇒ `model.onPremDefault`,
   * else `auto`; always local-only.
   */
  modelPolicy?: unknown
  repo?: { bundle: string; ref?: string }
  permission?: Record<string, unknown>
  listen?: { hostname?: string; port?: number }
}

/**
 * #101 (CAS ADR-042, Engines): every model call from the sandbox stays on-prem. The tier is set
 * after the manifest headers, so a manifest cannot remove or widen it.
 */
export const PRIVACY_TIER = "local-only"
/** The fork's Synapse plugin reads this and puts the tier on every Synapse call it makes. */
export const PRIVACY_TIER_ENV = "SYNAPSE_PRIVACY_TIER"

/** Header names are case-insensitive: drop every spelling of the tier the manifest sent. */
function withoutPrivacyTier(headers: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "x-privacy-tier"))
}

// One provider, nothing else enabled. The models come from the CAS AI-roles policy (#102), read
// by the supervisor at task start; the agent cannot pick another provider.
// The provider id is `synapse` so the fork's built-in Synapse plugin wraps every request: it
// merges system messages into one leading message (on-prem backends reject any other shape,
// "System message must be at the beginning.") and recovers text-form tool calls.
// `modelIds` is strongest last: the strongest is the main model, the first the small model.
export function renderConfig(manifest: Manifest, modelIds: string[]) {
  if (modelIds.length === 0) throw new Error("renderConfig needs at least one model id")
  return {
    $schema: "https://opencode.ai/config.json",
    model: `synapse/${modelIds[modelIds.length - 1]}`,
    small_model: `synapse/${modelIds[0]}`,
    enabled_providers: ["synapse"],
    provider: {
      synapse: {
        npm: "@ai-sdk/openai-compatible",
        name: "Sandbox model route",
        options: { headers: { ...withoutPrivacyTier(manifest.model.headers), "x-privacy-tier": PRIVACY_TIER } },
        models: Object.fromEntries(modelIds.map((id) => [id, { name: id }])),
        // The Synapse plugin swaps in the gateway's live list (#74); keep only the policy's models.
        // A convenience, not the boundary: the gateway enforces the cell server-side (ADR-042).
        whitelist: modelIds,
      },
    },
    // In-box permissions are a convenience, not the security boundary (ADR-037 decision 3).
    permission: manifest.permission ?? { "*": "allow", external_directory: "deny" },
    autoupdate: false,
    share: "disabled",
  }
}
