// T2.4 — permission baseline (technical-design §3.3) and `always` refusal (FM-4).
// The baseline is convenience, not a security boundary; these tests pin its shape and
// its effect under OpenCode's last-match-wins evaluation.
import { describe, expect, test } from "bun:test"
import { checkPermissionReply, permissionBaseline, type Rule } from "../src/guard/permissions.ts"

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
    ["ks-delegate_search-tools", "*", "allow"],
  ]

  for (const [permission, pattern, action] of cases) {
    test(`${permission} ${pattern} → ${action}`, () => expect(evaluate(rules, permission, pattern)).toBe(action))
  }

  test("keeps every standard rule", () => {
    const standard = permissionBaseline("standard")
    for (const rule of standard) expect(rules).toContainEqual(rule)
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
