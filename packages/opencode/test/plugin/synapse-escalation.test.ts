import { describe, expect, test } from "bun:test"
import {
  bumpTier,
  classifyFailure,
  declaredTier,
  EscalationTracker,
} from "../../src/plugin/synapse-escalation"

describe("declaredTier", () => {
  test("maps named models to their declared tiers", () => {
    expect(declaredTier("synapse/openai/gpt-5.6-sol")).toBe("premium")
    expect(declaredTier("anthropic/claude-opus-5")).toBe("premium")
    expect(declaredTier("z-ai/glm-5.3")).toBe("economy")
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
  test("escalates once after 2 consecutive same-class failures", () => {
    const t = new EscalationTracker()
    t.recordFailure("s1", "provider-error")
    expect(t.resolveTier("s1", "balanced")).toBe("balanced")
    t.recordFailure("s1", "provider-error")
    expect(t.resolveTier("s1", "balanced")).toBe("premium")
    // AIESC-03: must be re-earned - the next request is back at base.
    expect(t.resolveTier("s1", "balanced")).toBe("balanced")
  })

  test("a different failure class restarts the count", () => {
    const t = new EscalationTracker()
    t.recordFailure("s1", "provider-error")
    t.recordFailure("s1", "empty-content")
    t.recordFailure("s1", "empty-content")
    expect(t.resolveTier("s1", "balanced")).toBe("premium")
  })

  test("success clears the consecutive counter", () => {
    const t = new EscalationTracker()
    t.recordFailure("s1", "provider-error")
    t.recordSuccess("s1")
    t.recordFailure("s1", "provider-error")
    expect(t.resolveTier("s1", "balanced")).toBe("balanced")
  })

  test("caps at 2 auto-escalations per session and flags the human gate", () => {
    const t = new EscalationTracker()
    for (let round = 0; round < 3; round++) {
      t.recordFailure("s1", "provider-error")
      t.recordFailure("s1", "provider-error")
      const tier = t.resolveTier("s1", "balanced")
      if (round < 2) expect(tier).toBe("premium")
      else expect(tier).toBe("balanced")
    }
    t.recordFailure("s1", "provider-error")
    t.recordFailure("s1", "provider-error")
    expect(t.atCap("s1")).toBe(true)
  })

  test("AIESC-04: local-only never escalates across the privacy gate", () => {
    const t = new EscalationTracker()
    t.recordFailure("s1", "provider-error")
    t.recordFailure("s1", "provider-error")
    expect(t.resolveTier("s1", "balanced", { localOnly: true })).toBe("balanced")
  })

  test("AIESC-05: premium base has nowhere to escalate to", () => {
    const t = new EscalationTracker()
    t.recordFailure("s1", "malformed-output")
    t.recordFailure("s1", "malformed-output")
    expect(t.resolveTier("s1", "premium")).toBe("premium")
  })

  test("sessions are isolated", () => {
    const t = new EscalationTracker()
    t.recordFailure("s1", "provider-error")
    t.recordFailure("s1", "provider-error")
    t.recordFailure("s2", "provider-error")
    expect(t.resolveTier("s2", "balanced")).toBe("balanced")
    expect(t.resolveTier("s1", "balanced")).toBe("premium")
  })
})

describe("classifyFailure", () => {
  test("maps gateway responses to AIESC-02 classes", () => {
    expect(classifyFailure(502, "")).toBe("provider-error")
    expect(classifyFailure(200, "upstream overloaded")).toBe("provider-error")
    expect(classifyFailure(200, "model returned empty content")).toBe("empty-content")
    expect(classifyFailure(400, '{"message":"System message must be at the beginning.","type":"invalid_request_error"}')).toBe(
      "malformed-output",
    )
    expect(classifyFailure(401, "no creds")).toBe("other")
  })
})
