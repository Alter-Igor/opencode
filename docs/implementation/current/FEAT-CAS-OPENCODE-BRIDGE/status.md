# FEAT-CAS-OPENCODE-BRIDGE — Status

**Last updated:** 2026-08-02  
**Phase:** Bridge + OAuth select merged; insights wave on `cas-synapse-insights`  
**AIO (what we are doing with OpenCode):** [KB-AI-036](https://markdown.alterspective.com.au/a/Alterspective-IO/Alterspective-Intelligence/main/Reference/AI/Capabilities/KB-AI-036-OpenCode-Alterspective-Fork-And-CAS-Bridge.md)

## Delivered waves

### Wave 1 — Safe CAS bridge

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

### Wave 2 — OAuth connect / list / select

| Item | Path |
|------|------|
| OAuth flow notes | `oauth-select.md` |
| Tools | `cas-auth-status`, `cas-select-agent`, selection file |
| Slash | `/cas` |
| CAS issuer fix | alterspective-agent prod (issuer host `.com.au`) |

### Wave 3 — Synapse / run insights (2026-08-02)

| Item | Path |
|------|------|
| Insights design | `insights.md` |
| Index (this pack) | `INDEX.md` |
| Pipeline / list / insights / trace / probe | `.opencode/tool/cas-pipeline-status.ts`, `cas-safe-list-runs.ts`, `cas-safe-run-insights.ts`, `cas-safe-run-trace.ts`, `synapse-probe.ts` |
| Lib helpers | `.opencode/tool/cas-bridge-lib.ts` (REST, health, formatters, Synapse probe) |
| Slash command | `.opencode/command/cas-insights.md` |
| Routing prompt | observability table in `plugin/cas-bridge-routing.ts` |
| AIO article | `KB-AI-036` in Alterspective-Intelligence |

## Validation observed

From `packages/opencode` (insights wave):

```shell
bun test test/plugin/cas-bridge/cas-bridge-routing.test.ts
# 20 pass, 0 fail
```

Live (2026-08-02):

- CAS `/health` PROD `1.0.161` / `23e7ae1`, gateway → `synapse2-api.alterspective.com.au`
- `synapse_probe` `model=auto` → `x-synapse-served-model: qwen3-next-80b`, rate limit 119/120

## Enable

1. `opencode mcp auth alterspective-agent` (preferred) **or** set `CAS_MCP_TOKEN`.
2. Optional: `CAS_AGENT_ALLOWLIST=drafter,matter-audit,...`
3. Optional for probe: `SYNAPSE_API_KEY` or `GPAAS_API_KEY` (vault — never commit values).
4. Restart OpenCode (`opencodealt`).
5. `/cas` to connect list select; `/cas-insights` for pipeline + runs + Synapse routing.

## Follow-ups

- Keep **KB-AI-036** updated when bridge tools or hosts change (same PR/session when practical).
- Optional: tighten primary agent to deny raw `cas_delegate` and force safe tools only.
- Optional: background poller toast for `childRunId` handles.
