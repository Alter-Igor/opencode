// #102: the model ids come from CAS Admin → AI roles (`ai_role_policy`), never from this image
// (CAS ADR-042 decision 7, owner Q3b; interim Q5 = B: read once at task start).
// Fails closed: anything other than a good answer from CAS means Synapse `auto` with the
// `local-only` tier (#101), which Synapse routes to on-prem models only.

/** The versioned read-only resolve contract proposed in CAS #1674. */
export const RESOLVE_PATH = "/api/v1/ai-roles/resolve"
/** The coding engine's role in `ai_role_policy`. */
export const DEVELOPER_ROLE = "developer"
/** Synapse's own routing. With `x-privacy-tier: local-only` it stays on-prem. */
export const FALLBACK_MODEL = "auto"
export const POLICY_TIMEOUT_MS = 5_000
const MAX_MODEL_IDS = 20

export type PolicyRequest = {
  /** CAS base URL (or the gateway in front of it). */
  url: string
  /** `owner/repo`, lower-cased before the call. */
  repo: string
  taskType?: string
}

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

export function resolveUrl(request: PolicyRequest, role = DEVELOPER_ROLE): URL {
  const url = new URL(RESOLVE_PATH, request.url)
  url.searchParams.set("role", role)
  url.searchParams.set("repo", request.repo.toLowerCase())
  if (request.taskType) url.searchParams.set("taskType", request.taskType)
  return url
}

/**
 * Reads the resolved cell from a resolve response body. Accepts `{ cell, effectivePolicyVersion }`
 * (or the cell's fields at the top level). Returns a reason string when the body is unusable.
 */
export function parseResolveBody(body: unknown): ModelPolicy {
  if (!body || typeof body !== "object") return fallback("bad response: not an object")
  const record = body as Record<string, unknown>
  const version = record.effectivePolicyVersion
  if ((typeof version !== "string" || !version.trim()) && typeof version !== "number") {
    return fallback("bad response: no effectivePolicyVersion")
  }
  const cell = record.cell === undefined ? record : record.cell
  if (!cell || typeof cell !== "object") return fallback("bad response: cell is not an object")
  const { modelIds, residency, privacyTier } = cell as Record<string, unknown>
  let ids: string[] = []
  if (modelIds !== undefined) {
    if (!Array.isArray(modelIds) || modelIds.length > MAX_MODEL_IDS) return fallback("bad response: modelIds")
    if (!modelIds.every((id) => typeof id === "string" && id.trim() && !/\s/.test(id.trim()))) {
      return fallback("bad response: modelIds")
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

/** Calls CAS once. Never throws: every failure is a `fallback` with its reason. */
export async function resolveModelPolicy(input: {
  request?: PolicyRequest
  token?: string
  fetch?: typeof fetch
  timeoutMs?: number
}): Promise<ModelPolicy> {
  if (!input.request?.url || !input.request.repo) return fallback("no policy configured")
  let url: URL
  try {
    url = resolveUrl(input.request)
  } catch {
    return fallback("bad policy url")
  }
  const headers: Record<string, string> = { accept: "application/json" }
  if (input.token) headers.authorization = `Bearer ${input.token}`
  // A plain timer rather than AbortSignal.timeout: Bun did not fire that signal for a fetch
  // that never settles. The timer also covers reading the body.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException("policy call timed out", "TimeoutError")), input.timeoutMs ?? POLICY_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await (input.fetch ?? fetch)(url, { headers, signal: controller.signal })
    } catch (error) {
      return fallback(`unreachable: ${error instanceof Error ? error.name : "error"}`)
    }
    if (!response.ok) return fallback(`HTTP ${response.status}`)
    try {
      return parseResolveBody(await response.json())
    } catch {
      return fallback("bad response: not JSON")
    }
  } finally {
    clearTimeout(timer)
  }
}
