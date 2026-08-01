# Adversarial review synthesis

**Models:** `claude-fable-5`, `openai/gpt-5.6-sol`  
**Endpoint:** `https://synapse2-api.alterspective.com.au/v1/chat/completions`  
**Date:** 2026-08-01  

## Verdicts

| Model | Verdict |
|-------|---------|
| gpt-5.6-sol | **NO-GO as originally stated** — fix blockers then proceed in `.opencode/` |
| claude-fable-5 | **GO conditional** on 4-tool surface + mechanical guards |

## Incorporated into implementation

| Finding | Disposition |
|---------|-------------|
| Prompt routing is not enforcement | Routing is advisory; façades + tool allowlists + safe tools enforce surface |
| Broad `cas_*` tools | Exact 4 tools only; deny resolve + admin |
| Data egress / client data | Safe tool size caps + code/secret heuristics; prompt forbids auto history/code |
| Auth not verified | Missing env → empty Bearer → 401 fail-closed; degraded plugin text |
| 8h non-refresh token | Documented residual risk; get_run 401 surfaced as auth error |
| CAS output untrusted | Safe tool wraps response in untrusted fence |
| Weak verification | Unit tests for plugin + validation; live smoke optional |
| Subagent façade semantics | Docs state façades are local agents with limited tools, not CAS child sessions |

## Residual risks (accepted this wave)

- Model on primary agent can still call raw MCP tools if permissions allow (mitigated by permission denials for admin/resolve; primary retains list/delegate for power users — consider tightening later).
- Heuristic filters are defense-in-depth, not perfect DLP.
- Token minting still manual (CAS OAuth gap).
