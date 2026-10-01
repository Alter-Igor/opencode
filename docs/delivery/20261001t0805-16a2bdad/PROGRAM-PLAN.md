# Program plan — FEAT-OCD-001 follow-ups (run `20261001t0805-16a2bdad`)

planRevision: 2 · Director: Claude Code (Opus 5.5), the only writer · Project writer: the task's `project-manager` subagent (receipt reused from FEAT-OCD-001)

## Outcome

Close the open security and verification gaps left after the delegate MCP bridge merged (PR #52, #41), so the box holds no shared secret, cannot harm the host, cannot write to the company knowledge base, and its push notifications are proven in a real Claude Code session.

## Authority

- Owner standing approval 2026-10-01: "you are approved to do what needed for the next 25hrs". Covers reversible code/doc changes, branches, PRs, issues and tests.
- Not covered: merges to `dev` (each needs "merge PR #N into dev"), production config changes in Keystone, Synapse or RAG, external communications, user-data changes.
- Branch naming deviation: the owner rule allows only `aio repo-worktree new`, which names the branch after the worktree. Integration branch is `ocd-followups` (not `program/<run-id>/integration`); workstream branches are `ocd-<ws>`.

## Source items

| Item | Source | Beneficiary and job | User/business outcome | Baseline → target | Evidence and owner | Value state | Status |
|---|---|---|---|---|---|---|---|
| #54 | G-7 / R3-08 | Owner: keep the work PC healthy while agents run | The box cannot fill the host disk | Unbounded writable host bind → host writes capped (or none) | Live test: box writes past the cap fail, host folder stays under it. Director. | hypothesised | WS1 |
| #48 | W3C-02 | Firm and owner: every model call is tied to a person and revocable | No shared Synapse key in the box | 49-char shared `SYNAPSE_API_KEY` in box env → per-user, short-lived or revocable credential | Box env has no shared key; a model call from the box succeeds and Synapse attributes it to the owner. Director. | hypothesised | WS2 (research first) |
| #56 | F-R5-02 | Firm: the knowledge base every agent trusts cannot be changed from a sandbox | RAG write tools unreachable from the box, even with its token | Admin-owner write tools reachable (deny is soft) → refused at Keystone | Tool call from the box connection refused by Keystone policy. Director; Keystone change needs owner approval. | hypothesised | WS3 (research first) |
| #44 / T3.5 | Wave 2/3 | Delegating Claude session: learn of finished work without polling | Channel push seen in a real Claude Code session | Unit tests only → one observed `<channel>` notice | Session transcript showing the notice. Director; may need the owner to start a session. | hypothesised | WS4 |
| Lessons | Handover | Future agents: avoid the same traps | Two AILES lessons filed once | Deferred → PRs #1208, #1210 (duplicates #1209, #1211 closed; defect alterspective-rag-service#706) | PR URLs. Director. | enabled (curator review pending) | done |

## Workstreams and order

| Order | Workstream | Items | Write scope | Depends on | Branch | Reviewed head | Integration state |
|---:|---|---|---|---|---|---|---|
| 1 | WS1 handoff cap | #54 | `src/supervisor/workspaces-handoff.ts`, `workspaces*.ts` hand-off parts, `docker/compose.yaml` hand-off mounts, their tests | — | `ocd-handoff` | `bde00c57f9` (cycle 1 review: 0 C/H/M, 7 Low → fixing) | review cycle 1 |
| 2 | WS2 per-user Synapse | #48 | `src/synapse/*`, `guard/egress.ts` synapse block, profile `frontAuth`, config `boxEnv`/`OPENCODE_DELEGATE_PROJECT`, doctor/login/cli/runtime wiring (no `compose.yaml` change) | — (no write overlap with WS1 after all) | `ocd-synapse-user` | `7059f6cb88` (independent review running) | review cycle 1 |
| 3 | WS3 read-only RAG | #56 | Keystone (prod, owner-approved): service + private connection `rag-read`; bridge `src/shared/keystone*.ts`, README, tests | — | `ocd-rag-read` | `627912ffa1` (model panel: gemini-3.1-pro-preview + ornith-1.0-35b; 2 findings refuted, 1 Low documented) | clean, live box proof pending |
| 4 | WS4 channel proof | #44 | none, unless a fix is needed | — | — | — | not started |

Proportionality (R16): WS1 = one developer agent plus one independent reviewer. WS2 and WS3 share one read-only research agent first; build shape is decided after it. WS4 and lessons are done by the director.

## Risks

| Risk | Impact | Response | Owner |
|---|---|---|---|
| #48 needs a Keystone app credential with `credentials:broker` | Extra Keystone setup; a production change | Research first; ask the owner before any production change | Director |
| #56 needs a Keystone service policy change | Production change in Keystone | Research first; owner approval required | Director |
| #44 needs an interactive Claude Code session | Cannot be proven headless | Try headless; else ask the owner to start one | Director |
| Work queue heavy lane blocked by the memory floor | Slow test runs | Light-lane batches | Director |

## Decisions

| Decision | Owner | Due | Impact |
|---|---|---|---|
| WS2: silent 30-day renewal (refresh token on host, DPAPI) | Owner | decided 2026-10-01 | Deviates knowingly from the playbook's no-refresh-token rule |
| WS3: create Keystone `rag-read` service + private connection in production | Owner | approved 2026-10-01; done 08:44Z (`FF_RELAY_TOOL_POLICY` on; dry-runs deny 5 write tools, pass search) | — |

## Next actions

1. WS1 developer starts in `ocd-handoff`.
2. Research agent answers WS2 and WS3 (read-only).
3. Director: WS4 approach.

## Checkpoint log

- rev 2 (2026-10-01 ~08:50Z): WS1 built (live: no writable host bind; e2e-w3 PASS); review cycle 1 found 7 Low, fixes in progress. WS2 built (live in isolated `ocd-ws2`: no Synapse credential in the box, model call OK, refresh rotation OK, fail-closed 401). WS3 Keystone change done and bridge default switched. WS4: headless channel delivery does not work (tested twice); needs one interactive owner session after WS1 integrates. Lessons done (#1208, #1210; duplicates closed; rag-service#706).
