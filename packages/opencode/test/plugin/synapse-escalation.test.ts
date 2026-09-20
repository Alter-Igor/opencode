import { describe, expect, test } from "bun:test"
import {
  bumpTier,
  classifyFailure,
  declaredTier,
  EscalationTracker,
} from "../../src/plugin/synapse-escalation"

describe("declaredTier", () => {
  test("maps exact model ids to their declared tiers", () => {
    expect(declaredTier("synapse/openai/gpt-5.6-sol")).toBe("premium")
    expect(declaredTier("anthropic/claude-opus-5")).toBe("premium")
    expect(declaredTier("z-ai/glm-5.3")).toBe("economy")
  })

  test("variant ids are NOT matched by substring - declare or stay unknown", () => {
    expect(declaredTier("z-ai/glm-5.3-fast")).toBeUndefined()
    expect(declaredTier("anthropic/claude-opus-5-turbo")).toBeUndefined()
  })

  test("unknown and auto models have no declared tier", () => {
    expect(declaredTier("auto")).toBeUndefined()
    expect(declaredTier(undefined)).toBeUndefined()
  })
})

describe("bumpTier", () => {
  test("walks the ladder and stops at premium", () => {
    expect(bumpTier("economy")).toBe("balanced")
    expect(bumpTier("balanced")).toBe("premium")
    expect(bumpTier("premium")).toBe("premium")
  })
})

describe("EscalationTracker", () => {
  test("escalates once after 2 consecutive same-class failures, then must be re-earned", () => {
    const t = new EscalationTracker()
    t.recordFailure("s1", "provider-error")
    expect(t.resolveTier("s1", "balanced")).toBe("balanced")
    t.recordFailure("s1", "provider-error")
    expect(t.resolveTier("s1", "balanced")).toBe("premium")
    expect(t.resolveTier("s1", "balanced")).toBe("balanced")
    // A granted escalation clears the human-gate flag.
    expect(t.atCap("s1")).toBe(false)
  })

  test("escalates from an economy base", () => {
    const t = new EscalationTracker()
    t.recordFailure("s1", "empty-content")
    t.recordFailure("s1", "empty-content")
    expect(t.resolveTier("s1", "economy")).toBe("balanced")
  })

  test("a different failure class restarts the count", () => {
    const t = new EscalationTracker()
    t.recordFailure("s1", "provider-error")
    t.recordFailure("s1", "empty-content")
    t.recordFailure("s1", "empty-content")
    expect(t.resolveTier("s1", "balanced")).toBe("premium")
  })

  test("success clears the consecutive counter and the exhausted flag", () => {
    const t = new EscalationTracker()
    t.recordFailure("s1", "provider-error")
    t.recordSuccess("s1")
    t.recordFailure("s1", "provider-error")
    expect(t.resolveTier("s1", "balanced")).toBe("balanced")
    expect(t.atCap("s1")).toBe(false)
  })

  test("AIESC-04: local-only does NOT consume the streak - evidence is kept", () => {
    const t = new EscalationTracker()
    t.recordFailure("s1", "provider-error")
    t.recordFailure("s1", "provider-error")
    expect(t.resolveTier("s1", "balanced", { localOnly: true })).toBe("balanced")
    expect(t.atCap("s1")).toBe(true)
    // A later cloud-ok request still gets the earned escalation.
    expect(t.resolveTier("s1", "balanced")).toBe("premium")
    expect(t.atCap("s1")).toBe(false)
  })

  test("caps at 2 auto-escalations, then flags the human gate without wiping evidence", () => {
    const t = new EscalationTracker()
    for (let round = 0; round < 2; round++) {
      t.recordFailure("s1", "provider-error")
      t.recordFailure("s1", "provider-error")
      expect(t.resolveTier("s1", "balanced")).toBe("premium")
    }
    t.recordFailure("s1", "provider-error")
    t.recordFailure("s1", "provider-error")
    expect(t.resolveTier("s1", "balanced")).toBe("balanced")
    expect(t.atCap("s1")).toBe(true)
    const snap = t.snapshot("s1")
    expect(snap.escalations).toBe(2)
    expect(snap.maxEscalations).toBe(2)
    expect(snap.consecutiveFailures).toEqual({ cls: "provider-error", count: 2 })
    expect(snap.exhausted).toBe(true)
  })

  test("premium base has nowhere to escalate - human gate fires, no silent no-op", () => {
    const t = new EscalationTracker()
    t.recordFailure("s1", "malformed-output")
    t.recordFailure("s1", "malformed-output")
    expect(t.resolveTier("s1", "premium")).toBe("premium")
    expect(t.atCap("s1")).toBe(true)
  })

  test("sessions are isolated", () => {
    const t = new EscalationTracker()
    t.recordFailure("s1", "provider-error")
    t.recordFailure("s1", "provider-error")
    t.recordFailure("s2", "provider-error")
    expect(t.resolveTier("s2", "balanced")).toBe("balanced")
    expect(t.snapshot("s2").escalations).toBe(0)
    expect(t.resolveTier("s1", "balanced")).toBe("premium")
  })
})

describe("classifyFailure", () => {
  test("status outranks message text", () => {
    expect(classifyFailure(503, "upstream schema error")).toBe("provider-error")
    expect(classifyFailure(502, "")).toBe("provider-error")
  })

  test("classifies gateway bodies by content when status is not 5xx", () => {
    expect(classifyFailure(200, "upstream overloaded")).toBe("provider-error")
    expect(classifyFailure(200, "model returned empty content")).toBe("empty-content")
    expect(
      classifyFailure(400, '{"message":"System message must be at the beginning.","type":"invalid_request_error"}'),
    ).toBe("malformed-output")
    expect(classifyFailure(401, "no creds")).toBe("other")
  })
})

describe("bounded storage", () => {
  test("never evicts a session carrying failure evidence", () => {
    const t = new EscalationTracker()
    t.recordFailure("evidence", "provider-error")
    t.recordFailure("evidence", "provider-error")
    for (let i = 0; i < 150; i++) t.recordFailure(`filler-${i}`, "other")
    // The evidence session must survive; fillers are evicted instead.
    expect(t.snapshot("evidence").consecutiveFailures).toEqual({ cls: "provider-error", count: 2 })
  })
})
