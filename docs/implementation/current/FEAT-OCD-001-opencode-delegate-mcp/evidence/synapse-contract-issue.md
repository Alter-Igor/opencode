# Title: Publish per-role model fit (benchmark suitability) on GET /v1/models, and route on `x-task-role`

## Context

Consumers (opencodealt's delegate box, CAS agents, AIO) currently pick models blind or accept `auto`'s cost-first routing. Observed: `synapse/auto` routed a coding task to a model that produced 8 lines in 32 minutes, while `openai/gpt-6-astra` did the whole task in ~10 minutes and `moonshotai/kimi-k3` independently caught 4 defects the build's own tests missed (evidence: FEAT-OCD-001 owner report 2026-10-10, #852). Synapse already benchmarks models; consumers can't see the result. Owner decision D4 (2026-10-10): the fit table must live IN Synapse and travel with the model catalogue, so a re-benchmark updates every consumer with zero consumer-side changes. Two stages; the consumer stage is already shipped in the opencode fork (`oc_send/oc_start_session {taskRole}` pick against live `capabilities.suitability`; `oc_list_models` discovers role keys — nothing is hardcoded consumer-side, so this contract is the whole deal).

## 1. Contract: `capabilities.suitability` on GET /v1/models entries

```json
{ "id": "openai/gpt-6-astra",
  "capabilities": { "ops": ["chat"], "tools": true,
    "suitability": { "code": 0.92, "architecture": 0.81, "qa": 0.7, "ui": 0.55 } } }
```

- Values 0..1, one per known role, published only where benchmark evidence exists (absent = no data, NOT zero — consumers must fail open).
- Role vocabulary is Synapse's own, extensible; consumers discover keys from the list and must never hardcode them. Proposed start: `code`, `qa`, `architecture`, `ui`, `general` — refine freely.
- Bounded body: keep current 1 MB consumer cap in mind (delegate bridge refuses larger).
- Per-privacy-class note: if a role pick must honour `x-privacy-tier` (local-only), either publish suitability separately per routing class or document that scores describe cloud routes only. Consumers treat it as advisory either way.

## 2. Gateway routing: accept `x-task-role`

- Today the fork already sends `x-task-type: code` + `x-quality-tier`; `x-task-role` would be the finer companion. `auto` routing for a request carrying `x-task-role: qa` should prefer the highest `suitability.qa` among models the tier/privacy headers permit.
- Unknown role: ignore the hint and route as today (never 4xx on an unknown hint value).
- Observability: `x-synapse-served-model` already names the model served; add the role to gateway telemetry so the bench harness can correlate picks to outcomes (feeds the loop).

## 3. Why this beats consumer-side tables

Consumer README/model-name tables go stale on the first re-benchmark and cannot see per-account privacy/routing classes. With (1)+(2): the bridge's stage-1 pick (`taskRole` -> best offered model from live data) becomes optional — callers just pass `x-task-role` on `synapse/auto` and the gateway does it with the data it owns. The delegate box already emits the provider headers; the change to adopt is: profile sets `x-task-role` from the session's taskRole and sends `auto` instead of a named model.

## Consumer-side status (no Synapse work needed for stage 1)

- Fork bridge: `oc_send` / `oc_start_session` accept `taskRole`; `oc_list_models` returns discovered `roles` with ranked offered models; parse/ignore malformed scores; retire-guard kept (a pick never names a model the box doesn't offer). Tests: `alterspective/delegate-mcp/test/models-task-role.test.ts`.
- When (1) lands, consumers light up with no code change. When (2) lands, we flip the box to `auto` + header and drop the client pick.
