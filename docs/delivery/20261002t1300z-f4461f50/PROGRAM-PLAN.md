# Program plan: delegate-mcp operations (Synapse-only models, clean-up, reporting, agent skill)

- **Run id:** `20261002t1300z-f4461f50`
- **planRevision:** 1 (2026-10-02, program director: Claude Code session `cb058128`, sole writer)
- **Owner direction:** "we need to make sure our opencodealt only uses Synapse as the provider and only offers the models registered in synapse with the default being auto. continue" (2026-10-02), plus the earlier pick A (build clean-up, skill and reporting together). Standing merge approval to 2026-10-04 ~21:00 AEST (merges only; no production promotion).
- **Integration branch:** `delegate-ops` (worktree `X:\opencode---delegate-ops`). One PR to `dev` at the end.

## Outcome

Delegated coding is safe to run every day: it uses only Synapse with `auto` by default, it cleans up after itself, it reports how well it works, and agents know how to use it properly.

## Value contract

| Item | Beneficiary / job | Measure | Baseline (2026-10-02) | Target | Method |
|---|---|---|---|---|---|
| #71 Synapse only | Owner / company: model use stays inside the authorised gateway | Non-Synapse models offered in the box; default model | 9 `opencode/*` models; default `opencode/big-pickle` and `synapse/openai/gpt-5.6-sol` | 0 non-Synapse; default `synapse/auto`; list = Synapse `/v1/models` | `oc_list_models`; a send with `opencode/...` is refused |
| #72 Clean-up | Owner: no orphaned copies, branches or records | Box copies / host records left after closing finished sessions | 43 copies, 41 records, 1 `delegate/*` branch | Closing a session removes all of it; a sweep clears idle sessions older than N days | Counts before and after on the live box |
| #73 Reporting | Owner: proof delegation works and which model is best | Per-task records with model and outcome; `oc_report` summary | No model recorded; no summary | Every task recorded; `oc_report` gives tasks, success rate, duration, collected vs discarded, by model | Run 2+ tasks live, read `oc_report` |
| Skill | Every agent that delegates | An agent following the skill runs start, send, wait, review, collect, merge or close, and clean-up correctly | No skill in the catalogue | Skill published in Alterspective-Intelligence and found by `rag_match_skills` | `rag_match_skills` for a delegate task returns it |

Value state: **hypothesised**.

## Workstreams

| ID | Scope (exclusive write) | Depends on | Branch |
|---|---|---|---|
| WS-1 | #71: `src/supervisor/profile.ts`, `src/tools/models.ts`, default-model handling in `src/tools/sessions.ts` / `src/tools/send.ts` / `src/tools/core-session.ts`, any new host-side Synapse model-list module under `src/synapse/`, their tests | — | `delegate-synapse-only` |
| WS-2 | #72: new `src/tools/close-session.ts` (or similar), `src/supervisor/workspaces*.ts`, the tool registry, the sweep, their tests | — | `delegate-cleanup` |
| WS-3 | #73: per-task record module + `oc_report` tool; hooks in send, wait, result, collect and close | WS-2 integrated | later |
| WS-4 | Skill in Alterspective-Intelligence `Skills/` (cross-repo, own worktree and PR) | WS-1, WS-2, WS-3 integrated | later |

Shared files (README, CHANGELOG, `package.json` version) are written only by the director at integration; each workstream reports its doc text.

**Proportionality:** one repo plus one docs repo. The director acts as manager. One developer per workstream (about 120 tool calls, no child agents) and one independent reviewer per workstream (4-cycle budget).

## Knowledge record

Standards used by earlier workstreams this session apply: `WEBSTA-001-CODING-STANDARDS`, `WEBSTA-001-SECRETS-MANAGEMENT-STANDARDS`, `WEBSTA-001-DOCUMENTATION-STANDARDS`. Each agent records its own RAG query.

## Project receipt

`opencode Delivery` (#16): #71 item `260630859` (In Progress, Current, P1), #72 item `260630987` (In Progress, Current, P3), #73 item `260631066` (Planned, Roadmap, P2). Priorities assessed by an independent reviewer (`ornith-1.0-35b`). Writer: program director.

## Review ledger

(none yet)

## Next actions

1. Brief WS-1 and WS-2 developers.
2. Independent review per workstream; integrate WS-1 and WS-2 into `delegate-ops`.
3. WS-3, then WS-4; combined review; PR to `dev`; live check of every value measure.
