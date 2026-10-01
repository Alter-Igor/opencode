// MOD-02 permission baseline (technical-design §3.3), applied in the profile config and on
// every POST /session.
//
// CONVENIENCE, NOT A SECURITY BOUNDARY. These rules reduce accidents; they do not contain a
// misbehaving agent:
// - bash `ask` patterns match the command text and are bypassable (e.g. an alias, a script
//   file, `sh -c`, or a different spelling — review G1);
// - subagents drop `ask` rules (packages/opencode/src/agent/subagent-permissions.ts:20-23);
// - the agent has a shell inside the box either way.
// The boundaries are the egress front (docker/front), the fork MCP allowlist patch, and the bridge guard.
// No R7 (Keystone-only) claim rests on anything in this file.
//
// OpenCode evaluates rules last-match-wins (permission/index.ts `evaluate` uses findLast), so
// the catch-all comes first and specific rules follow.
import type { Verdict } from "../shared/contracts.ts"

export type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }

/** Bash commands that leave the sandbox's effects on shared state or destroy work. */
const ASK_BASH = ["git push*", "gh pr merge*", "rm -rf*"]

function standard(): Rule[] {
  return [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "deny" },
    { permission: "webfetch", pattern: "*", action: "ask" },
    ...ASK_BASH.map((pattern): Rule => ({ permission: "bash", pattern, action: "ask" })),
    { permission: "doom_loop", pattern: "*", action: "ask" },
    // Keystone MCP tools (entry names are ks-*, tool ids are <entry>_<tool>).
    { permission: "ks-*_*", pattern: "*", action: "allow" },
  ]
}

function readonly(): Rule[] {
  return [
    ...standard(),
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "ask" },
    // Keystone tools may change remote state, so a read-only session asks first
    // (review A-16). Last-match-wins: this overrides the standard `ks-*_*` allow above.
    { permission: "ks-*_*", pattern: "*", action: "ask" },
  ]
}

/** A fresh ruleset each call, so callers may extend it without sharing state. */
export function permissionBaseline(profile: "standard" | "readonly"): Rule[] {
  return profile === "readonly" ? readonly() : standard()
}

/**
 * The bridge answers permission requests with `once` or `reject` only. `always` would add a
 * standing allow rule to the running session (FM-4), so it is refused; anything unknown is too.
 */
export function checkPermissionReply(reply: string): Verdict {
  if (reply === "once" || reply === "reject") return { ok: true }
  if (reply.trim().toLowerCase() === "always") {
    return { ok: false, code: "policy_violation", reason: "`always` replies are refused; answer once or reject" }
  }
  return { ok: false, code: "policy_violation", reason: `unknown permission reply ${JSON.stringify(reply)}; answer once or reject` }
}
