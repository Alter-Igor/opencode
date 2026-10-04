// #102: the model ids come from CAS Admin → AI roles (`ai_role_policy`), never from this image
// (CAS ADR-042 decision 7, owner Q3b).
//
// Who resolves it: svc-coding-agent, not the sandbox. The service calls the CAS resolve endpoint
// (`GET /api/v1/ai-roles/resolve`, CAS #1674) with its own Keystone credential, caches it for at
// most 5 minutes, freezes the answer for the task, and passes that answer to the sandbox verbatim
// as `manifest.modelPolicy`. The sandbox therefore holds no CAS credential (ADR-037 decision 1,
// kept by ADR-042) and makes no policy call of its own.
//
// Fails closed: a missing or unusable `modelPolicy` means Synapse `auto` with the `local-only`
// tier (#101), which Synapse routes to on-prem models only.

/** Synapse's own routing. With `x-privacy-tier: local-only` it stays on-prem. */
export const FALLBACK_MODEL = "auto"
const MAX_MODEL_IDS = 20

export type ModelPolicy =
  | {
      source: "cas"
      /** Strongest last (the `ai_role_policy` convention). Never empty. */
      modelIds: string[]
      effectivePolicyVersion: string
      residency?: string
      privacyTier?: string
    }
  | { source: "fallback"; modelIds: [typeof FALLBACK_MODEL]; reason: string }

const fallback = (reason: string): ModelPolicy => ({ source: "fallback", modelIds: [FALLBACK_MODEL], reason })

/**
 * Reads a CAS resolve answer, as passed through in the manifest: `{ cell, effectivePolicyVersion }`
 * (or the cell's fields at the top level). Anything unusable fails closed with a reason.
 */
export function parseResolveBody(body: unknown): ModelPolicy {
  if (body === undefined || body === null) return fallback("no model policy in the manifest")
  if (typeof body !== "object") return fallback("bad model policy: not an object")
  const record = body as Record<string, unknown>
  const version = record.effectivePolicyVersion
  if ((typeof version !== "string" || !version.trim()) && typeof version !== "number") {
    return fallback("bad model policy: no effectivePolicyVersion")
  }
  const cell = record.cell === undefined ? record : record.cell
  if (!cell || typeof cell !== "object") return fallback("bad model policy: cell is not an object")
  const { modelIds, residency, privacyTier } = cell as Record<string, unknown>
  let ids: string[] = []
  if (modelIds !== undefined) {
    if (!Array.isArray(modelIds) || modelIds.length > MAX_MODEL_IDS) return fallback("bad model policy: modelIds")
    if (!modelIds.every((id) => typeof id === "string" && id.trim() && !/\s/.test(id.trim()))) {
      return fallback("bad model policy: modelIds")
    }
    ids = modelIds.map((id: string) => id.trim())
  }
  return {
    source: "cas",
    // No role pin in the policy ("today's model selection applies") means Synapse routing.
    modelIds: ids.length ? ids : [FALLBACK_MODEL],
    effectivePolicyVersion: String(version),
    ...(typeof residency === "string" ? { residency } : {}),
    ...(typeof privacyTier === "string" ? { privacyTier } : {}),
  }
}
