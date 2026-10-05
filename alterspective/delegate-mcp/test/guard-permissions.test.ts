// T2.4 — permission baseline (technical-design §3.3) and `always` refusal (FM-4).
// The baseline is convenience, not a security boundary; these tests pin its shape and
// its effect under OpenCode's last-match-wins evaluation.
import { describe, expect, test } from "bun:test"
import { checkPermissionReply, permissionBaseline, type Rule } from "../src/guard/permissions.ts"
import { createGuard, gateAsksForRisky } from "../src/guard/index.ts"
import { defaultConfig } from "../src/shared/config.ts"

// Mirror of packages/opencode/src/util/wildcard.ts + permission/index.ts `evaluate` (findLast).
function wildcard(input: string, pattern: string): boolean {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", "s").test(input)
}

function evaluate(rules: Rule[], permission: string, pattern: string): Rule["action"] {
  const match = [...rules].reverse().find((r) => wildcard(permission, r.permission) && wildcard(pattern, r.pattern))
  return match?.action ?? "ask"
}

describe("permissionBaseline(standard)", () => {
  const rules = permissionBaseline("standard")

  const cases: Array<[string, string, Rule["action"]]> = [
    ["read", "src/a.ts", "allow"],
    ["edit", "src/a.ts", "allow"],
    ["bash", "bun test", "allow"],
    ["bash", "git status", "allow"],
    ["bash", "git push", "ask"],
    ["bash", "git push origin main --force", "ask"],
    ["bash", "gh pr merge 12 --squash", "ask"],
    ["bash", "rm -rf /sessions/x", "ask"],
    ["external_directory", "/etc", "deny"],
    ["webfetch", "https://example.com", "ask"],
    ["doom_loop", "*", "ask"],
    ["ks-delegate_get-my-identity", "*", "allow"],
  ]

  for (const [permission, pattern, action] of cases) {
    test(`${permission} ${pattern} → ${action}`, () => expect(evaluate(rules, permission, pattern)).toBe(action))
  }

  test("starts with the catch-all so later rules win", () => {
    expect(rules[0]).toEqual({ permission: "*", pattern: "*", action: "allow" })
  })

  test("returns a fresh array each call", () => {
    const again = permissionBaseline("standard")
    again.push({ permission: "x", pattern: "*", action: "allow" })
    expect(permissionBaseline("standard")).toEqual(rules)
  })
})

describe("permissionBaseline(readonly)", () => {
  const rules = permissionBaseline("readonly")

  const cases: Array<[string, string, Rule["action"]]> = [
    ["read", "src/a.ts", "allow"],
    ["edit", "src/a.ts", "deny"],
    ["bash", "ls", "ask"],
    ["bash", "git push", "ask"],
    ["external_directory", "/etc", "deny"],
    ["webfetch", "https://example.com", "ask"],
    ["ks-delegate_search-tools", "*", "ask"],
    ["ks-rag_rag-search", "*", "ask"],
  ]

  for (const [permission, pattern, action] of cases) {
    test(`${permission} ${pattern} → ${action}`, () => expect(evaluate(rules, permission, pattern)).toBe(action))
  }

  test("ends with the Keystone-tools ask rule so it wins over the standard allow (A-16)", () => {
    expect(rules[rules.length - 1]).toEqual({ permission: "ks-*_*", pattern: "*", action: "ask" })
  })

  test("keeps every standard rule", () => {
    const standard = permissionBaseline("standard")
    for (const rule of standard) expect(rules).toContainEqual(rule)
  })
})

describe("#104: read-only sessions and the dynamic connection (owner decision A)", () => {
  test("gated: ks-dynamic tools are allowed, other Keystone tools still ask, edits and shell unchanged", () => {
    const rules = permissionBaseline("readonly", undefined, true)
    expect(evaluate(rules, "ks-dynamic_execute-tool", "*")).toBe("allow")
    expect(evaluate(rules, "ks-dynamic_search-tools", "*")).toBe("allow")
    expect(evaluate(rules, "ks-github_add_issue_comment", "*")).toBe("ask")
    expect(evaluate(rules, "edit", "src/a.ts")).toBe("deny")
    expect(evaluate(rules, "bash", "ls")).toBe("ask")
  })

  test("not gated (approvals listed): ks-dynamic tools still ask", () => {
    expect(evaluate(permissionBaseline("readonly", undefined, false), "ks-dynamic_execute-tool", "*")).toBe("ask")
  })

  test("narrowed to dynamic + github: dynamic allowed only when gated, github asks, others denied", () => {
    const rules = permissionBaseline("readonly", ["dynamic", "github"], true)
    expect(evaluate(rules, "ks-dynamic_execute-tool", "*")).toBe("allow")
    expect(evaluate(rules, "ks-github_issue_read", "*")).toBe("ask")
    expect(evaluate(rules, "ks-seqlogs_query", "*")).toBe("deny")
    expect(evaluate(permissionBaseline("readonly", ["dynamic"], false), "ks-dynamic_execute-tool", "*")).toBe("ask")
  })

  test("standard sessions do not change with the flag", () => {
    expect(permissionBaseline("standard", undefined, true)).toEqual(permissionBaseline("standard"))
    expect(permissionBaseline("standard", ["dynamic"], true)).toEqual(permissionBaseline("standard", ["dynamic"]))
  })

  test("gateAsksForRisky: default and risky profiles ask at the gate; listed or a damaged profile does not", () => {
    expect(gateAsksForRisky("")).toBe(true)
    expect(gateAsksForRisky('{"approvals":"risky"}')).toBe(true)
    expect(gateAsksForRisky('{"deniedToolPatterns":["m365__*"]}')).toBe(true)
    expect(gateAsksForRisky('{"approvals":"listed"}')).toBe(false)
    expect(gateAsksForRisky("{not json")).toBe(false)
  })

  test("createGuard reads the owner's profile, and the tool deny list still comes last", () => {
    const base = defaultConfig({})
    expect(evaluate(createGuard(base).permissionBaseline("readonly"), "ks-dynamic_execute-tool", "*")).toBe("allow")
    const listed = createGuard({ ...base, dynamicProfile: '{"approvals":"listed"}' }).permissionBaseline("readonly")
    expect(evaluate(listed, "ks-dynamic_execute-tool", "*")).toBe("ask")
    const denied = createGuard({ ...base, keystoneToolDeny: ["ks-dynamic_execute-tool"] }).permissionBaseline("readonly")
    expect(evaluate(denied, "ks-dynamic_execute-tool", "*")).toBe("deny")
  })
})

describe("checkPermissionReply", () => {
  test("once is allowed", () => expect(checkPermissionReply("once")).toEqual({ ok: true }))
  test("reject is allowed", () => expect(checkPermissionReply("reject")).toEqual({ ok: true }))

  for (const reply of ["always", "ALWAYS", " always", "allow", "", "yes"]) {
    test(`${JSON.stringify(reply)} is a policy_violation`, () => {
      expect(checkPermissionReply(reply)).toMatchObject({ ok: false, code: "policy_violation" })
    })
  }
})
