# Program plan — FEAT-OCD-001 follow-ups (run `20261001t0805-16a2bdad`)

planRevision: 1 · Director: Claude Code (Opus 5.5), the only writer · Project writer: the task's `project-manager` subagent (receipt reused from FEAT-OCD-001)

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
| 1 | WS1 handoff cap | #54 | `src/supervisor/workspaces-handoff.ts`, `workspaces*.ts` hand-off parts, `docker/compose.yaml` hand-off mounts, their tests | — | `ocd-handoff` | — | not started |
| 2 | WS2 per-user Synapse | #48 | research read-only; then `docker/compose.yaml` env, profile provider config, maybe fork Synapse plugin | WS1 integrated (shared `compose.yaml`) | `ocd-synapse-user` | — | research |
| 3 | WS3 read-only RAG | #56 | research read-only; then Keystone policy (owner gate) and bridge default set | research | `ocd-rag-read` | — | research |
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
| Keystone production changes for WS2/WS3 | Owner | after research | Blocks WS2/WS3 build |

## Next actions

1. WS1 developer starts in `ocd-handoff`.
2. Research agent answers WS2 and WS3 (read-only).
3. Director: WS4 approach.
