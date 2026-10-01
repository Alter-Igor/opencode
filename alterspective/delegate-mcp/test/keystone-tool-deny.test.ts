// R5-02 / R5-06: write tools of the chosen services are denied in the box profile and in every
// session's rules (convenience, not a wall). OpenCode evaluates agent rules then session rules,
// last match wins (packages/opencode/src/permission/index.ts evaluate/merge), so the deny must be
// the LAST rule of both, after the `ks-*_*` allow and after any per-session narrowing.
import { describe, expect, test } from "bun:test"
import { createGuard } from "../src/guard/index.ts"
import { defaultConfig } from "../src/shared/config.ts"
import { DelegateError } from "../src/shared/errors.ts"
import { DEFAULT_TOOL_DENY, TOOL_DENY_ENV, toolDenyNames } from "../src/shared/keystone-policy.ts"
import { buildProfile } from "../src/supervisor/profile.ts"

type Rule = { permission: string; pattern: string; action: string }

/** OpenCode's Wildcard.match for permission names: `*` is any run of characters. */
const match = (value: string, pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(value)
/** OpenCode's evaluate(): the last matching rule across agent rules then session rules. */
const evaluate = (permission: string, ...rulesets: Rule[][]) => [...rulesets.flat()].reverse().find((r) => match(permission, r.permission) && match("*", r.pattern))?.action ?? "ask"

describe("default tool deny list (R5-02, R5-06)", () => {
  test("covers the RAG write tools and the SeqLogs tools that change shared state", () => {
    expect([...DEFAULT_TOOL_DENY]).toEqual([
      "ks-rag-global_rag_ingest",
      "ks-rag-global_rag_ingest_document",
      "ks-rag-global_rag_delete_collection",
      "ks-rag-global_rag_contribute",
      "ks-seqlogs_set_tenant_alias",
      "ks-seqlogs_start_tenant_monitor",
      "ks-seqlogs_stop_tenant_monitor",
    ])
    expect(defaultConfig({}).keystoneToolDeny).toEqual([...DEFAULT_TOOL_DENY])
  })

  test("configurable from the launch env (replaces the default; empty means none); a bad name fails closed", () => {
    expect(defaultConfig({ [TOOL_DENY_ENV]: "ks-github_create_or_update_file, ks-github_*_write" }).keystoneToolDeny).toEqual(["ks-github_create_or_update_file", "ks-github_*_write"])
    expect(defaultConfig({ [TOOL_DENY_ENV]: "" }).keystoneToolDeny).toEqual([])
    for (const bad of ["rag_ingest", "ks-rag-global", "ks-Rag_x", "ks-a_b c", "*"]) expect(() => toolDenyNames([bad])).toThrow(DelegateError)
  })

  test("profile and session rules end with the deny list, so the profile's ks-*_* allow cannot win", () => {
    const guard = createGuard(defaultConfig({}))
    const profile = guard.permissionBaseline("standard")
    const session = guard.permissionBaseline("standard")
    expect(profile.slice(-DEFAULT_TOOL_DENY.length)).toEqual(DEFAULT_TOOL_DENY.map((permission) => ({ permission, pattern: "*", action: "deny" })))
    for (const name of DEFAULT_TOOL_DENY) expect({ name, action: evaluate(name, profile, session) }).toEqual({ name, action: "deny" })
    expect(evaluate("ks-rag-global_rag_search", profile, session)).toBe("allow")
    expect(evaluate("ks-github_create_or_update_file", profile, session)).toBe("allow")
  })

  test("per-session narrowing and the readonly profile cannot give a denied tool back", () => {
    const guard = createGuard(defaultConfig({}))
    for (const session of [guard.permissionBaseline("standard", ["rag-global"]), guard.permissionBaseline("readonly"), guard.permissionBaseline("readonly", ["seqlogs"])]) {
      expect(evaluate("ks-rag-global_rag_ingest", guard.permissionBaseline("standard"), session)).toBe("deny")
      expect(evaluate("ks-seqlogs_start_tenant_monitor", guard.permissionBaseline("standard"), session)).toBe("deny")
    }
  })

  test("the box profile's opencode.json carries the deny after the ks-*_* allow", () => {
    const config = defaultConfig({})
    const built = buildProfile({ ownerConfigs: [], config: { ...config, boxEnv: [] }, permission: createGuard(config).permissionBaseline("standard"), tools: {} })
    const permission = (JSON.parse(built.files["opencode/opencode.json"]!) as { permission: Record<string, unknown> }).permission
    const keys = Object.keys(permission)
    expect(permission["ks-rag-global_rag_ingest"]).toBe("deny")
    expect(keys.indexOf("ks-rag-global_rag_ingest")).toBeGreaterThan(keys.indexOf("ks-*_*"))
  })
})
