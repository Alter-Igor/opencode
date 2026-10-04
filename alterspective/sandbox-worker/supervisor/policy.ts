// #102: the model ids come from CAS Admin → AI roles (`ai_role_policy`), never from this image
// (CAS ADR-042 decision 7, owner Q3b).
//
// Who resolves it: svc-coding-agent, not the sandbox. The service calls the CAS resolve endpoint
// (`GET /api/v1/ai-roles/resolve`, CAS #1674) with its own Keystone credential, caches it for at
// most 5 minutes, freezes the answer for the task, and passes that answer to the sandbox verbatim
// as `manifest.modelPolicy`. The sandbox therefore holds no CAS credential (ADR-037 decision 1,
// kept by ADR-042) and makes no policy call of its own.
//
// Fails closed, always at the `local-only` tier (#101), which Synapse routes to on-prem models only:
// a missing or unusable `modelPolicy` uses the service's configured on-prem default
// (`manifest.model.onPremDefault`, ADR-042 "local-only with the on-prem default") when one is
// given, else Synapse `auto`. Plain `auto` may route to an on-prem model that failed the
// svc-coding-agent#4 quality gate, so the service should always send its default. If that model is
// not served, the fork's pinned-model fallback (#80) resends with `auto`.

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
  | { source: "fallback"; modelIds: string[]; reason: string }

/** A usable model id list: 1..20 non-blank ids with no whitespace. Undefined otherwise. */
function modelIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODEL_IDS) return undefined
  if (!value.every((id) => typeof id === "string" && id.trim() && !/\s/.test(id.trim()))) return undefined
  return value.map((id: string) => id.trim())
}

/**
 * Reads a CAS resolve answer, as passed through in the manifest: `{ cell, effectivePolicyVersion }`
 * (or the cell's fields at the top level). Anything unusable fails closed with a reason.
 */
export function parseResolveBody(body: unknown, onPremDefault?: unknown): ModelPolicy {
  const fallbackIds = modelIdList(onPremDefault)
  const fallback = (reason: string): ModelPolicy => ({
    source: "fallback",
    modelIds: fallbackIds ?? [FALLBACK_MODEL],
    reason: fallbackIds ? `${reason}; using the on-prem default` : reason,
  })
  if (body === undefined || body === null) return fallback("no model policy in the manifest")
  if (typeof body !== "object") return fallback("bad model policy: not an object")
  const record = body as Record<string, unknown>
  const version = record.effectivePolicyVersion
  if ((typeof version !== "string" || !version.trim()) && typeof version !== "number") {
    return fallback("bad model policy: no effectivePolicyVersion")
  }
  const cell = record.cell === undefined ? record : record.cell
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return fallback("bad model policy: cell is not an object")
  const { modelIds, residency, privacyTier } = cell as Record<string, unknown>
  let ids: string[] = []
  if (modelIds !== undefined && !(Array.isArray(modelIds) && modelIds.length === 0)) {
    const parsed = modelIdList(modelIds)
    if (!parsed) return fallback("bad model policy: modelIds")
    ids = parsed
  }
  return {
    source: "cas",
    // No role pin (modelIds missing or empty; CAS treats both as `[]`, "today's model selection
    // applies") means the service's selection: its on-prem default, else Synapse routing.
    modelIds: ids.length ? ids : (fallbackIds ?? [FALLBACK_MODEL]),
    effectivePolicyVersion: String(version),
    ...(typeof residency === "string" ? { residency } : {}),
    ...(typeof privacyTier === "string" ? { privacyTier } : {}),
  }
}
