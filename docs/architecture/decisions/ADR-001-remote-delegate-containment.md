---
id: OCD-ADR-001
title: Contain unsupported remote delegation
status: accepted
category: architecture-decision
---

# ADR-001 — contain unsupported remote delegation

Date: 2026-10-25 UTC / 2026-10-26 AEDT. Decision owner: Igor Jericevich. The approval was relayed and recorded at 2026-10-25T13:42:59Z: “Approve temporary block (Recommended)”. This record is agent-scribed; it records that decision, not a separate approval or a passing implementation test.

## Context

The bridge at `c4fa54c46bfeadd0b9488703161686cb1901b52f` starts remote work from a session title before the real prompt arrives. Its remote readiness stubs also claim local policy checks passed. The deployed service contract at `acfcb8bbe7fd6187f0f650347be066496402917b` has no fields for the bridge's requested model, agent, system instructions or permission/read-only profile. Its strict request requires an idempotency key and caps goals at 8,000 characters, while bridge messages allow 100,000 characters plus separate repository instructions.

The [prebuild record](../../implementation/current/FEAT-OCD-001-opencode-delegate-mcp/evidence/remote-containment-241-prebuild.md) preserves the frozen five-source-file contract, three independent reviews, source evidence and named approval. [Issue #241](https://github.com/Alter-Igor/opencode/issues/241) stays open for a supported replacement execution contract.

## Decision

Refuse remote execution through the runtime and independently through adapter create/send. Return the existing typed `policy_unverified` error before workspace capture, saved-record mutation or scheduling. Remove synthetic MCP/model/healthy-policy successes.

Remote doctor reports separate bounded observations from anonymous `GET /health` and, only when a remote token is already configured, authenticated `GET /api/v1/repos`. It never mints a client-credential token, signs in, refreshes tokens or reads local Docker/front/sign-in/lease state. Output contains allowlisted status, outcome, shape and timing facts. Bodies and raw errors are excluded. Doctor always reports `verified:false`; health and catalog authentication do not attest execution policy.

Reuse the existing backend URL/token/deadline and adapter/context boundaries. Add no dependency, new setting, task store, identity mapping or backend framework. Local Docker behavior is unchanged by this decision. A separate operator owns the approved five-record local test; this decision changes none of that data.

No standards exception is requested. The exception register is N/A; there is no fictitious exception row or automatic expiry of the safety guard. The separate merge/deploy authority window ends at 2026-10-27T08:30Z; it does not switch this guard off.

## Alternatives

Leaving the code unchanged preserves the unsupported scheduling path. A deferred-start implementation would need a separately designed durable session/task mapping, restart recovery, concurrent-send and idempotency handling, as well as a service contract that can represent and enforce caller intent. Neither alternative is part of the approved containment.

## Exit and rollback

Remote execution can be re-enabled only by a reviewed, verified replacement contract covering prompt/model/profile fidelity, enforcement, durable lifecycle and truthful readiness. This patch has no timer or override that enables it automatically.

Rollback is a normal reviewed revert of the containment code. It needs no data or infrastructure migration. Restoring the old code does not establish its safety or authorize its use. Required tests and nonauthor final-head architecture review remain delivery gates.
