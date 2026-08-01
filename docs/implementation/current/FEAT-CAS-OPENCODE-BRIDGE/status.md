# FEAT-CAS-OPENCODE-BRIDGE — Status

**Last updated:** 2026-08-01  
**Phase:** Implemented on branch `cas-opencode-bridge` (not yet merged)

## Delivered

| Item | Path |
|------|------|
| Plan (post-adversarial) | `plan.md` |
| Adversarial synthesis | `adversarial-synthesis.md` |
| MCP + permission denials | `.opencode/opencode.jsonc` |
| Routing plugin | `.opencode/plugin/cas-bridge-routing.ts` |
| Safe tools + lib | `.opencode/tool/cas-*.ts`, `cas-bridge-lib.ts` |
| Façade agents | `.opencode/agent/cas-*.md` |
| Tests | `packages/opencode/test/plugin/cas-bridge/` |
| AGENTS.md note | fork-local bullet |

## Validation observed

From `packages/opencode`:

```shell
bun test test/plugin/cas-bridge/cas-bridge-routing.test.ts
# 11 pass, 0 fail
```

Live CAS MCP smoke with real `CAS_MCP_TOKEN` not run (token absent on this machine).

## Enable

1. Mint CAS MCP OAuth bearer for `https://agent.alterspective.com.au/api/v1/mcp`.
2. Set user env `CAS_MCP_TOKEN` (optional `CAS_AGENT_ALLOWLIST=drafter,matter-audit,...`).
3. Restart `opencodealt`.
4. Use `@cas-delegate` / `@cas-drafter` / `@cas-matter-audit` or `cas_safe_delegate`.

## Follow-ups

- CAS OAuth issuer/refresh (CAS repo).
- Optional: tighten primary agent to deny raw `cas_delegate` and force safe tools only.
