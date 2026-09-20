// AIESC-001 (draft) mechanics: declared tiers + observer-owned escalation.
// Pure logic here so it is unit-testable; wiring lives in plugin/synapse.ts.

export type QualityTier = "economy" | "balanced" | "premium"
export type FailureClass = "provider-error" | "empty-content" | "malformed-output" | "other"

const TIER_ORDER: QualityTier[] = ["economy", "balanced", "premium"]

// AIESC-01: tiers are DECLARED per exact model id (config-reviewable), never
// inferred from prompt content and never by substring (variant ids like
// "z-ai/glm-5.3-fast" must be declared explicitly, not matched accidentally).
// Unknown/auto models stay balanced.
const DECLARED_TIERS: Record<string, QualityTier> = {
  "openai/gpt-5.6-sol": "premium",
  "anthropic/claude-opus-5": "premium",
  "z-ai/glm-5.3": "economy",
  "google/gemini-3.7-flash": "economy",
  "qwen/qwen3-coder-next": "economy",
}

export function declaredTier(modelId: string | undefined): QualityTier | undefined {
  if (!modelId) return undefined
  return DECLARED_TIERS[modelId.replace(/^synapse\//, "")]
}

export function bumpTier(tier: QualityTier): QualityTier {
  return TIER_ORDER[Math.min(TIER_ORDER.indexOf(tier) + 1, TIER_ORDER.length - 1)]
}

interface SessionState {
  failures: { cls: FailureClass; count: number } | null
  escalations: number
  // True when failures persist but no escalation is possible (local-only,
  // budget spent, or already premium) - the human-gate condition.
  exhausted: boolean
}

export class EscalationTracker {
  private sessions = new Map<string, SessionState>()
  private static readonly MAX_SESSIONS = 100

  constructor(private maxEscalations = 2) {}

  private state(key: string): SessionState {
    const existing = this.sessions.get(key)
    if (existing) return existing
    if (this.sessions.size >= EscalationTracker.MAX_SESSIONS) {
      // Never evict a session with live evidence or an open human gate.
      const evictable = this.sessions.entries().find(([, v]) => !v.failures && !v.exhausted)
      if (evictable) this.sessions.delete(evictable[0])
      else {
        // Bound preserved with no evictable entry: the overflow session gets a
        // throwaway state - no escalation budget, no map growth (fail closed).
        return { failures: null, escalations: 0, exhausted: false }
      }
    }
    const fresh: SessionState = { failures: null, escalations: 0, exhausted: false }
    this.sessions.set(key, fresh)
    return fresh
  }

  recordFailure(key: string, cls: FailureClass) {
    const s = this.state(key)
    if (s.failures && s.failures.cls === cls) s.failures.count++
    else s.failures = { cls, count: 1 }
  }

  recordSuccess(key: string) {
    const s = this.state(key)
    s.failures = null
    s.exhausted = false
  }

  // AIESC-02/03: after 2 consecutive same-class failures, ONE request goes one
  // tier up, then must be re-earned. The streak is consumed only when the
  // escalation is actually granted - a blocked attempt (local-only, cap, no
  // headroom) keeps the evidence and marks the session exhausted so the
  // human-gate instruction fires. AIESC-04: never escalates across a
  // local-only privacy gate. Returns the tier to apply to THIS request.
  resolveTier(key: string, base: QualityTier, opts?: { localOnly?: boolean }): QualityTier {
    const s = this.state(key)
    if (!s.failures || s.failures.count < 2) return base
    if (opts?.localOnly || s.escalations >= this.maxEscalations) {
      s.exhausted = true
      return base
    }
    const target = bumpTier(base)
    if (target === base) {
      s.exhausted = true
      return base
    }
    s.failures = null
    s.exhausted = false
    s.escalations++
    return target
  }

  // Release a completed session slot (session.deleted) so the bound holds without
  // evicting live evidence.
  release(key: string) {
    this.sessions.delete(key)
  }

  // AIESC-03 human gate: failures persist while escalation is impossible.
  atCap(key: string): boolean {
    return this.state(key).exhausted
  }

  snapshot(key: string) {
    const s = this.state(key)
    return {
      escalations: s.escalations,
      maxEscalations: this.maxEscalations,
      consecutiveFailures: s.failures ? { cls: s.failures.cls, count: s.failures.count } : null,
      exhausted: s.exhausted,
    }
  }
}

export function classifyFailure(status: number, message?: string): FailureClass {
  // Status first: a 5xx is a provider failure whatever its body says.
  if (status >= 500 || status === 0) return "provider-error"
  const text = message || ""
  if (/empty[\s-]*content|no content|content.{0,12}empty/i.test(text)) return "empty-content"
  if (/tool_call|malformed|invalid_request|schema/i.test(text)) return "malformed-output"
  if (/provider|upstream|overload|bad gateway|service unavailable/i.test(text)) return "provider-error"
  return "other"
}


// Detect the AI-SDK NoSuchToolError surface: a native tool call whose name
// arrived malformed (observed when an on-prem server converts the model's
// XML-style drift into a tool_call delta with a garbage name). Returns the
// session key to charge the failure to, or undefined for any other event.
export function malformedToolCallFromEvent(event: {
  type: string
  properties?: any
}): { sessionID: string; partID?: string } | undefined {
  if (event.type !== "message.part.updated") return undefined
  const part = event.properties?.part
  if (!part || part.type !== "tool" || part.state?.status !== "error") return undefined
  const error = typeof part.state.error === "string" ? part.state.error : ""
  if (!/tried to call unavailable tool|no such tool/i.test(error)) return undefined
  const sessionID = part.sessionID ?? event.properties?.sessionID
  if (!sessionID) return undefined
  return { sessionID, partID: typeof part.id === "string" ? part.id : undefined }
}


