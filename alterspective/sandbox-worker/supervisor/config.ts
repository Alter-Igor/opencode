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
     * `modelPolicy` is missing or unusable. Absent too ⇒ Synapse `auto`. The tier is
     * `resolvePrivacyTier`'s: `local-only` by default (#101, #161).
     */
    onPremDefault?: string[]
  }
  /**
   * #102: the CAS AI-roles resolve answer for this task (`{ cell, effectivePolicyVersion }`), resolved
   * and frozen by svc-coding-agent and passed through verbatim. Absent or unusable ⇒ `model.onPremDefault`,
   * else `auto`. It never sets the tier: that is the manifest's `privacyTier` (#161).
   */
  modelPolicy?: unknown
  /**
   * #161: the privacy tier for the task, set only by svc-coding-agent from its own residency
   * decision (svc#322). The box never infers it: anything but the exact string "cloud-ok",
   * including absent, is `local-only` (see `resolvePrivacyTier`).
   */
  privacyTier?: unknown
  /**
   * #108: `sha256` is the bundle file's SHA-256 and `treeSha` the expected tree of the checked-out
   * commit. When given, the supervisor refuses to start on a mismatch.
   */
  /**
   * #85 (svc-coding-agent): `dependencies` is an absolute path to a `node_modules` folder the SERVICE
   * prepared as root before the egress lockdown (`npm ci --ignore-scripts` from the lockfile) and
   * chowned to the agent user. The supervisor moves it into the clone; the agent never reaches a
   * registry. Given but missing or not a folder ⇒ refuse to start.
   */
  repo?: { bundle: string; ref?: string; sha256?: string; treeSha?: string; dependencies?: string }
  permission?: Record<string, unknown>
  /**
   * #121: the service will run hidden acceptance tests after the agent claims GOAL_MET.
   * Informational only: the command and tests never come from the manifest or the box; the
   * service sends them to `harness-run.ts` (run as root) after the session.
   */
  harness?: { required: boolean }
  listen?: { hostname?: string; port?: number }
}

/**
 * #161: the default tier, used when the manifest does not clearly allow the cloud. Kept exported
 * under its old name so existing imports still compile.
 */
export const PRIVACY_TIER = "local-only"
/** The fork's Synapse plugin reads this and puts the tier on every Synapse call it makes. */
export const PRIVACY_TIER_ENV = "SYNAPSE_PRIVACY_TIER"

/**
 * #161: resolves the task's privacy tier from the manifest's top-level `privacyTier` field, which
 * svc-coding-agent sets from its own residency decision (svc#322). Fails closed: the answer is
 * "cloud-ok" ONLY when the field is exactly the string "cloud-ok" (no trimming, no other case).
 * Everything else, including absent, null, "Cloud-OK", " cloud-ok", objects and arrays, is
 * "local-only". Headers, `modelPolicy` and model ids never change the tier.
 */
export function resolvePrivacyTier(manifest: Pick<Manifest, "privacyTier">): "local-only" | "cloud-ok" {
  return manifest.privacyTier === "cloud-ok" ? "cloud-ok" : PRIVACY_TIER
}

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
  // #161: the resolved tier is set LAST, after every manifest spelling of the header is stripped,
  // so a manifest header can neither remove nor widen it.
  const tier = resolvePrivacyTier(manifest)
  return {
    $schema: "https://opencode.ai/config.json",
    model: `synapse/${modelIds[modelIds.length - 1]}`,
    small_model: `synapse/${modelIds[0]}`,
    enabled_providers: ["synapse"],
    provider: {
      synapse: {
        npm: "@ai-sdk/openai-compatible",
        name: "Sandbox model route",
        options: { headers: { ...withoutPrivacyTier(manifest.model.headers), "x-privacy-tier": tier } },
        models: Object.fromEntries(modelIds.map((id) => [id, { name: id }])),
        // The Synapse plugin merges the gateway's live list in (#74) and keeps these even when
        // that list omits one (svc#366); the whitelist keeps only the policy's models.
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

/**
 * The environment for the `opencode serve` child (#161). The resolved tier is set after the spread
 * of `base`, so an inherited `SYNAPSE_PRIVACY_TIER` (e.g. `cloud-ok` from the host) can never
 * override what the manifest resolves to.
 */
export function serveEnv(base: Record<string, string | undefined>, tier: "local-only" | "cloud-ok") {
  const { SBXW_SERVER_PASSWORD: _drop, SBXW_MANIFEST: _manifest, ...env } = base
  return { ...env, [PRIVACY_TIER_ENV]: tier }
}
