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
import { DYNAMIC_ID, entryName, keystoneIds } from "../shared/keystone.ts"
import { toolDenyNames } from "../shared/keystone-policy.ts"

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

/**
 * #104 (owner decision A, 2026-10-05): the dynamic entry's tools (search-tools, get-tool-schema,
 * execute-tool) need no OpenCode ask in a read-only session when the delegation gate outside the
 * box already holds every risky call for an approval. Asking at both layers only multiplied the
 * prompts. `dynamicGated` is false when the owner's profile asks only for listed tools.
 */
const dynamicAllow = (): Rule => ({ permission: `${entryName(DYNAMIC_ID)}_*`, pattern: "*", action: "allow" })

/**
 * Safe read-only commands that review and inspection sessions need without interactive approval (#140).
 */
const READONLY_BASH_ALLOW = [
  "git status*",
  "git log*",
  "git diff*",
  "git show*",
  "git branch*",
  "git rev-parse*",
  "cat *",
  "head *",
  "tail *",
  "grep *",
  "ls *",
  "ls",
  "pwd",
  "find *",
  "sed -n *",
]

function readonly(dynamicGated: boolean): Rule[] {
  return [
    ...standard(),
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "ask" },
    ...READONLY_BASH_ALLOW.map((pattern): Rule => ({ permission: "bash", pattern, action: "allow" })),
    // Keystone tools may change remote state, so a read-only session asks first
    // (review A-16). Last-match-wins: this overrides the standard `ks-*_*` allow above.
    { permission: "ks-*_*", pattern: "*", action: "ask" },
    // #140: read-only Keystone connections like rag-read need no human approval
    { permission: "ks-rag-read_*", pattern: "*", action: "allow" },
    ...(dynamicGated ? [dynamicAllow()] : []),
  ]
}

/**
 * Per-session narrowing to a subset of the chosen Keystone connections (oc_start_session
 * {keystone}). CONVENIENCE ONLY, like the rest of this file: in-box code can call Keystone with
 * the box's tokens directly, so this only keeps a well-behaved agent to the named services; the
 * front proxy enforces the box-wide set. Last-match-wins: first deny every Keystone tool and MCP
 * resource read, then give the named connections back the profile's own Keystone action. MCP tool
 * ids are `<entry>_<tool>` and resource reads ask `read` for `mcp:<entry>:<uri>`; entry names
 * have no `_` or `:`, so `ks-<id>_*` and `mcp:ks-<id>:*` match that entry only.
 */
function narrowed(profile: "standard" | "readonly", ids: readonly string[], dynamicGated: boolean): Rule[] {
  const action: Rule["action"] = profile === "readonly" ? "ask" : "allow"
  return [
    { permission: "ks-*_*", pattern: "*", action: "deny" },
    { permission: "read", pattern: "mcp:ks-*:*", action: "deny" },
    ...ids.flatMap((id): Rule[] => [
      { permission: `${entryName(id)}_*`, pattern: "*", action: id === DYNAMIC_ID && dynamicGated ? "allow" : action },
      { permission: "read", pattern: `mcp:${entryName(id)}:*`, action: "allow" },
    ]),
  ]
}

/**
 * A fresh ruleset each call, so callers may extend it without sharing state. `keystone` (validated
 * connection ids) narrows the session's Keystone tools to those connections; omitted, no narrowing.
 * `dynamicGated` (#104): the delegation gate asks before risky tools, so read-only sessions allow
 * the dynamic entry's tools; createGuard works it out from the owner's delegation profile.
 */
export function permissionBaseline(profile: "standard" | "readonly", keystone?: readonly string[], dynamicGated = false): Rule[] {
  const base = profile === "readonly" ? readonly(dynamicGated) : standard()
  return keystone === undefined ? base : [...base, ...narrowed(profile, keystoneIds(keystone), dynamicGated)]
}

/**
 * R5-02 / R5-06: deny rules for write tools of the chosen services (`ks-<id>_<tool>`), to be put
 * AFTER every other rule. CONVENIENCE, like the rest of this file: OpenCode then hides the tool and
 * refuses calls to it, but in-box code can still call the connection with the box's tokens.
 */
export function toolDenyRules(names: readonly string[]): Rule[] {
  return toolDenyNames(names).map((permission): Rule => ({ permission, pattern: "*", action: "deny" }))
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
