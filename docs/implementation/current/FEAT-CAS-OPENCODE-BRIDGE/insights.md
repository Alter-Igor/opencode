# FEAT-CAS-OPENCODE-BRIDGE — Observability & Synapse insights

**Date:** 2026-08-02  
**Branch:** `cas-synapse-insights`  
**Scope:** fork-local `.opencode/` only  

**Canonical product narrative (AIO):**  
[KB-AI-036 — OpenCode (Alterspective fork) — CAS bridge & Synapse insights](https://markdown.alterspective.com.au/a/Alterspective-IO/Alterspective-Intelligence/main/Reference/AI/Capabilities/KB-AI-036-OpenCode-Alterspective-Fork-And-CAS-Bridge.md)  
(`Reference/AI/Capabilities/KB-AI-036-OpenCode-Alterspective-Fork-And-CAS-Bridge.md` in Alterspective-Intelligence)

## Why

CAS agent turns are opaque from OpenCode: after `cas_safe_delegate` you get a report (or run id) but not **how** the request was processed — which persona loop, how many turns, token spend on Synapse, correlation for Langfuse, or which model the gateway actually served.

## What shipped

| Tool | Purpose | Auth |
|------|---------|------|
| `cas_pipeline_status` | CAS `/health` + Synapse `/health` + credential presence | none (health) / reports auth flags |
| `cas_safe_list_runs` | Recent runs (status, agent, tokens) via MCP `cas_list_runs` | CAS OAuth / `CAS_MCP_TOKEN` |
| `cas_safe_run_insights` | One run: status, turns, token spend, wall time, `correlationId` | CAS |
| `cas_safe_run_trace` | Durable step trace `GET /api/v1/runs/:id/trace` | CAS |
| `synapse_probe` | Tiny chat; reports `x-synapse-served-model`, rate limits, usage | `SYNAPSE_API_KEY` or `GPAAS_API_KEY` |

Slash command: **`/cas-insights`**. Routing plugin documents the observability table.

### Implementation files

| Path | Role |
|------|------|
| `.opencode/tool/cas-bridge-lib.ts` | REST helper, health fetchers, run formatters, `probeSynapseChat`, redaction |
| `.opencode/tool/cas-pipeline-status.ts` | Pipeline snapshot tool |
| `.opencode/tool/cas-safe-list-runs.ts` | List runs |
| `.opencode/tool/cas-safe-run-insights.ts` | Formatted run insights |
| `.opencode/tool/cas-safe-run-trace.ts` | Trace via CAS REST |
| `.opencode/tool/synapse-probe.ts` | Live gateway probe |
| `.opencode/command/cas-insights.md` | Slash-command flow |
| `.opencode/plugin/cas-bridge-routing.ts` | System-prompt observability table |
| `packages/opencode/test/plugin/cas-bridge/cas-bridge-routing.test.ts` | Unit tests (formatters + routing) |

## Mental model

```
OpenCode  --OAuth-->  CAS (agent loop, tools, approvals)
                         |
                         |  every LLM turn
                         v
                      Synapse gateway (routing, served model, token bill)
                         dashboard: https://synapse.alterspective.com.au
```

- **CAS** owns personas, runs, traces, correlationId → Langfuse.
- **Synapse** owns model routing (`x-synapse-served-model`), rate limits, GPU/cloud choice.
- Credentials are **different**: CAS OAuth ≠ Synapse `gpaas_`/`gpapp_` PAT.

### correlationId surfaces (do not “normalise”)

| Surface | Name |
|---------|------|
| HTTP request header | `x-correlation-id` |
| CAS run field / internal | `correlationId` |
| CAS JSON error envelope | `correlation_id` |

## Live probe evidence (2026-08-02)

`POST https://synapse2-api.alterspective.com.au/v1/chat/completions` with `model: auto`:

- Response header `x-synapse-served-model: qwen3-next-80b` (local GPU path)
- `x-ratelimit-limit: 120`, `x-ratelimit-remaining: 119`
- Body `usage.total_tokens: 15`
- Latency on the order of ~100–120 ms for a tiny "pong" probe

Pinned `anthropic/claude-haiku-4.5` → served model matches pin.

CAS prod health reports:

- `gateway.baseUrl: https://synapse2-api.alterspective.com.au`
- model hint `anthropic/claude-haiku-4.5`
- `version: 1.0.161` / `sha: 23e7ae1`
- Langfuse on

## Operator checklist

1. `cas_pipeline_status` — confirm CAS + Synapse healthy and which credentials are present.
2. `synapse_probe` with `model=auto` — see actual served model + rate limits.
3. After a delegate: `cas_safe_list_runs` → `cas_safe_run_insights` / `cas_safe_run_trace`.
4. Thread `correlationId` into Langfuse / log search when debugging a failed run.

## Validation

From `packages/opencode`:

```shell
bun test test/plugin/cas-bridge/cas-bridge-routing.test.ts
# 20 pass, 0 fail (insights wave, 2026-08-02)
```

Live smoke (no secrets printed):

```shell
# from repo root, with SYNAPSE_API_KEY or GPAAS_API_KEY set
bun -e "import { fetchCasHealth, probeSynapseChat, formatSynapseProbe } from './.opencode/tool/cas-bridge-lib.ts'; console.log(await fetchCasHealth()); console.log(formatSynapseProbe(await probeSynapseChat({ model: 'auto' })))"
```

## Follow-ups

- Re-auth CAS when `mcp-auth.json` only has `oauthState` (incomplete login): `opencode mcp auth alterspective-agent`.
- Optional: toast/poller for background `childRunId` handles (WAVE-3 in plan).
- Keep AIO KB-AI-036 in sync when tool surface or hosts change.
