# FEAT-CAS-OPENCODE-BRIDGE — Index

**Status:** Implemented (bridge + OAuth select + Synapse/run insights)  
**Repo:** Alterspective fork of OpenCode (`Alter-Igor/opencode`, default branch `dev`)  
**Scope:** fork-local `.opencode/` + docs + tests (prefer zero `packages/*/src` churn)

## Canonical knowledge base (AIO)

**[KB-AI-036 — OpenCode (Alterspective fork) — CAS bridge & Synapse insights](https://markdown.alterspective.com.au/a/Alterspective-IO/Alterspective-Intelligence/main/Reference/AI/Capabilities/KB-AI-036-OpenCode-Alterspective-Fork-And-CAS-Bridge.md)**  
Path in Alterspective-Intelligence:  
`Reference/AI/Capabilities/KB-AI-036-OpenCode-Alterspective-Fork-And-CAS-Bridge.md`

Use the KB article for **what we are doing with OpenCode** (architecture, credentials, operator flows, tool inventory, live evidence). This folder is the **implementation plan, review trail, and status** inside the product repo.

Related AIO:

| ID | Topic |
|----|--------|
| [KB-AI-022](https://markdown.alterspective.com.au/a/Alterspective-IO/Alterspective-Intelligence/main/Reference/AI/Patterns/KB-AI-022-Central-Agent-Service.md) | CAS product |
| [KB-AI-021](https://markdown.alterspective.com.au/a/Alterspective-IO/Alterspective-Intelligence/main/Reference/AI/Capabilities/KB-AI-021-Synapse-AI-Gateway-Integration.md) | Synapse gateway |
| [KB-AI-015](https://markdown.alterspective.com.au/a/Alterspective-IO/Alterspective-Intelligence/main/Reference/AI/Capabilities/KB-AI-015-AI-Tool-Routing-Guide.md) | Tool routing (includes OpenCode rows) |

## Documents in this folder

| File | Purpose |
|------|---------|
| [plan.md](./plan.md) | Hardened Option B plan (post adversarial review) |
| [adversarial-synthesis.md](./adversarial-synthesis.md) | Decisions from fable + gpt-5.6-sol reviews |
| [adversarial-review-fable.md](./adversarial-review-fable.md) | Full fable review |
| [adversarial-review-gpt56.md](./adversarial-review-gpt56.md) | Full gpt-5.6-sol review |
| [oauth-select.md](./oauth-select.md) | Wave 2: OAuth connect + list + select agents |
| [insights.md](./insights.md) | Wave 3: CAS run insights + Synapse probe |
| [status.md](./status.md) | Delivery status, enable steps, validation |

## Quick start (operators)

```text
1. opencode mcp auth alterspective-agent     # browser OAuth
2. Restart OpenCode / reconnect MCP
3. /cas                                      # list → select → optional delegate
4. /cas-insights                             # pipeline + runs + Synapse routing
```

Optional env:

- `CAS_MCP_TOKEN` — override CAS bearer (prefer OAuth)
- `CAS_AGENT_ALLOWLIST` — expand beyond default Foundry personas
- `SYNAPSE_API_KEY` or `GPAAS_API_KEY` — for `synapse_probe` only (not CAS OAuth)

## Code map

| Area | Path |
|------|------|
| MCP + permissions | `.opencode/opencode.jsonc` |
| Routing / degraded prompt | `.opencode/plugin/cas-bridge-routing.ts` |
| Shared lib (MCP, REST, formatters, probe) | `.opencode/tool/cas-bridge-lib.ts` |
| Safe + insight tools | `.opencode/tool/cas-*.ts`, `synapse-probe.ts` |
| Slash commands | `.opencode/command/cas.md`, `cas-insights.md` |
| Façade agents | `.opencode/agent/cas-*.md` |
| Tests | `packages/opencode/test/plugin/cas-bridge/` |
