// AIESC-001 (draft) mechanics: declared tiers + observer-owned escalation.
// Pure logic here so it is unit-testable; wiring lives in plugin/synapse.ts.

export type QualityTier = "economy" | "balanced" | "premium"
export type FailureClass = "provider-error" | "empty-content" | "malformed-output" | "other"

const TIER_ORDER: QualityTier[] = ["economy", "balanced", "premium"]

// AIESC-01: tiers are DECLARED per named model (config-reviewable), never
// inferred from prompt content. Unknown/auto models stay balanced.
const DECLARED_TIERS: Record<string, QualityTier> = {
  "openai/gpt-5.6-sol": "premium",
  "anthropic/claude-opus-5": "premium",
  "z-ai/glm-5.3": "economy",
  "google/gemini-3.7-flash": "economy",
  "qwen/qwen3-coder-next": "economy",
}

export function declaredTier(modelId: string | undefined): QualityTier | undefined {
  if (!modelId) return undefined
  const id = modelId.replace(/^synapse\//, "")
  for (const [key, tier] of Object.entries(DECLARED_TIERS)) {
    if (id.includes(key)) return tier
  }
  return undefined
}

export function bumpTier(tier: QualityTier): QualityTier {
  return TIER_ORDER[Math.min(TIER_ORDER.indexOf(tier) + 1, TIER_ORDER.length - 1)]
}

interface SessionState {
  failures: { cls: FailureClass; count: number } | null
  escalations: number
}

export class EscalationTracker {
  private sessions = new Map<string, SessionState>()

  constructor(private maxEscalations = 2) {}

  private state(key: string): SessionState {
    let s = this.sessions.get(key)
    if (!s) {
      s = { failures: null, escalations: 0 }
      this.sessions.set(key, s)
    }
    return s
  }

  recordFailure(key: string, cls: FailureClass) {
    const s = this.state(key)
    if (s.failures && s.failures.cls === cls) s.failures.count++
    else s.failures = { cls, count: 1 }
  }

  recordSuccess(key: string) {
    const s = this.state(key)
    s.failures = null
  }

  // AIESC-02/03: after 2 consecutive same-class failures, ONE request goes one
  // tier up, then must be re-earned. AIESC-04: never escalates across a
  // local-only privacy gate. Returns the tier to apply to THIS request.
  resolveTier(key: string, base: QualityTier, opts?: { localOnly?: boolean }): QualityTier {
    const s = this.state(key)
    if (!s.failures || s.failures.count < 2) return base
    s.failures = null
    if (opts?.localOnly) return base
    if (s.escalations >= this.maxEscalations) return base
    const target = bumpTier(base)
    if (target === base) return base
    s.escalations++
    return target
  }

  // AIESC-03 human gate: escalation budget spent while still failing.
  atCap(key: string): boolean {
    const s = this.state(key)
    return s.escalations >= this.maxEscalations && (s.failures?.count ?? 0) >= 2
  }

  snapshot(key: string) {
    const s = this.state(key)
    return {
      escalations: s.escalations,
      maxEscalations: this.maxEscalations,
      consecutiveFailures: s.failures ? { cls: s.failures.cls, count: s.failures.count } : null,
      atCap: this.atCap(key),
    }
  }
}

export function classifyFailure(status: number, message?: string): FailureClass {
  const text = message || ""
  if (/empty[\s-]*content|no content|content.{0,12}empty/i.test(text)) return "empty-content"
  if (/tool_call|malformed|invalid_request|schema/i.test(text)) return "malformed-output"
  if (status >= 500 || status === 0 || /provider|upstream|overload|bad gateway|service unavailable/i.test(text))
    return "provider-error"
  return "other"
}
