// The managed OpenCode config the supervisor writes (FEAT-CAS-012, fork #47).
// Pure: no I/O, so it can be tested without a container.

export type Manifest = {
  taskId: string
  model: { baseURL: string; id: string; headers?: Record<string, string> }
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

// One provider, one model, nothing else enabled. The model is fixed by the manifest, which
// CAS derives from its policy decision; the agent cannot pick another provider.
// The provider id is `synapse` so the fork's built-in Synapse plugin wraps every request: it
// merges system messages into one leading message (on-prem backends reject any other shape,
// "System message must be at the beginning.") and recovers text-form tool calls.
export function renderConfig(manifest: Manifest) {
  return {
    $schema: "https://opencode.ai/config.json",
    model: `synapse/${manifest.model.id}`,
    small_model: `synapse/${manifest.model.id}`,
    enabled_providers: ["synapse"],
    provider: {
      synapse: {
        npm: "@ai-sdk/openai-compatible",
        name: "Sandbox model route",
        options: { headers: { ...withoutPrivacyTier(manifest.model.headers), "x-privacy-tier": PRIVACY_TIER } },
        models: { [manifest.model.id]: { name: manifest.model.id } },
      },
    },
    // In-box permissions are a convenience, not the security boundary (ADR-037 decision 3).
    permission: manifest.permission ?? { "*": "allow", external_directory: "deny" },
    autoupdate: false,
    share: "disabled",
  }
}
