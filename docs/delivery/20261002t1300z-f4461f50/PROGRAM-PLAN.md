# Program plan: delegate-mcp operations (Synapse-only models, clean-up, reporting, agent skill)

- **Run id:** `20261002t1300z-f4461f50`
- **planRevision:** 5 (2026-10-03). Rev 5: #77 merged (`20fcf451d5`); live value check passed for #71-#73; skill PR merged. Rev 4: WS-3 reviewed and integrated; WS-4 skill PR open (Alterspective-IO/Alterspective-Intelligence#1270); combined review done and fixed; PR #77 to `dev`; follow-up #76 filed; local paths removed. Rev 3: WS-1, WS-1b and WS-2 reviewed clean and integrated (review ledger); RAG search working again; WS-3 started; follow-up #75 filed. Rev 2: owner confirmed Synapse-only everywhere; owner's local config made Synapse-only; #74 (fork plugin live models) added as WS-1b; WS-1, WS-1b and WS-2 built and pushed (`ed26ea57c6`, `07621eb61e`, `f8ec25f7e6`) and in independent review; RAG outage and owner deviation recorded. Rev 1 (2026-10-02, program director: Claude Code session `cb058128`, sole writer)
- **Owner direction:** "we need to make sure our opencodealt only uses Synapse as the provider and only offers the models registered in synapse with the default being auto. continue" (2026-10-02), plus the earlier pick A (build clean-up, skill and reporting together). Standing merge approval to 2026-10-04 ~21:00 AEST (merges only; no production promotion).
- **Integration branch:** `delegate-ops`. One PR to `dev` at the end: #77.

## Outcome

Delegated coding is safe to run every day: it uses only Synapse with `auto` by default, it cleans up after itself, it reports how well it works, and agents know how to use it properly.

## Value contract

| Item | Beneficiary / job | Measure | Baseline (2026-10-02) | Target | Method |
|---|---|---|---|---|---|
| #71 Synapse only | Owner / company: model use stays inside the authorised gateway | Non-Synapse models offered in the box; default model | 9 `opencode/*` models; default `opencode/big-pickle` and `synapse/openai/gpt-5.6-sol` | 0 non-Synapse; default `synapse/auto`; list = Synapse `/v1/models` | `oc_list_models`; a send with `opencode/...` is refused |
| #72 Clean-up | Owner: no orphaned copies, branches or records | Box copies / host records left after closing finished sessions | 43 copies, 41 records, 1 `delegate/*` branch | Closing a session removes all of it; a sweep clears idle sessions older than N days | Counts before and after on the live box |
| #73 Reporting | Owner: proof delegation works and which model is best | Per-task records with model and outcome; `oc_report` summary | No model recorded; no summary | Every task recorded; `oc_report` gives tasks, success rate, duration, collected vs discarded, by model | Run 2+ tasks live, read `oc_report` |
| Skill | Every agent that delegates | An agent following the skill runs start, send, wait, review, collect, merge or close, and clean-up correctly | No skill in the catalogue | Skill published in Alterspective-Intelligence and found by `rag_match_skills` | `rag_match_skills` for a delegate task returns it |

Value state (2026-10-03, after #77 merged): **observed** for #71, #72 and #73 on the live box (evidence: `docs/implementation/current/FEAT-OCD-001-opencode-delegate-mcp/evidence/value-check-0.2.0-live.md`). #74: the owner's OpenCode offers only Synapse models, but the plugin's live fetch was not observed. The likely cause, not verified, is an expired stored sign-in at startup; startup then uses the configured list, by design. Skill: merged (Alterspective-IO/Alterspective-Intelligence#1270); the `rag_match_skills` measure waits for the catalogue to pick it up.

## Workstreams

| ID | Scope (exclusive write) | Depends on | Branch |
|---|---|---|---|
| WS-1 | #71: `src/supervisor/profile.ts`, `src/tools/models.ts`, default-model handling in `src/tools/sessions.ts` / `src/tools/send.ts` / `src/tools/core-session.ts`, any new host-side Synapse model-list module under `src/synapse/`, their tests | — | `delegate-synapse-only` |
| WS-1b | #74: `packages/opencode/src/plugin/synapse.ts` (config hook) and new `synapse-models.ts`, tests | — | `synapse-live-models` |
| WS-2 | #72: new `src/tools/close-session.ts` (or similar), `src/supervisor/workspaces*.ts`, the tool registry, the sweep, their tests | — | `delegate-cleanup` |
| WS-3 | #73: per-task record module + `oc_report` tool; hooks in send, wait, result, collect and close | WS-2 integrated | later |
| WS-4 | Skill in Alterspective-Intelligence `Skills/` (cross-repo, own worktree and PR) | WS-1, WS-2, WS-3 integrated | later |

Shared files (README, CHANGELOG, `package.json` version) are written only by the director at integration; each workstream reports its doc text.

**Proportionality:** one repo plus one docs repo. The director acts as manager. One developer per workstream (about 120 tool calls, no child agents) and one independent reviewer per workstream (4-cycle budget).

## Owner deviation: RAG-first (recorded 2026-10-03)

- **Observed:** since the RAG production deploy (v1.153.0, `2606f2e`, 2026-10-02 13:46 UTC), `rag_search` returns `embedding_space_mismatch` ("The collection does not match the required embedding space.") on both the MCP tool and REST `/search`. `/health` reports ok.
- **Rule set aside:** the estate-wide `AGENTS.md` § Knowledge Search: "do not continue substantive work until it is restored".
- **Owner decision:** "B" (2026-10-03): continue with the standards already loaded this session. Agents read the standards files directly (`WEBSTA-001-CODING-STANDARDS`, `WEBSTA-001-SECRETS-MANAGEMENT-STANDARDS`, `AILES-056`) and record that RAG was unavailable.
- **Restored:** `rag_search` answered normally again on 2026-10-03 (receipt `754c1030-7c65-4849-97a3-78cc63bd4fa0`). Later reviews and WS-3 record their own RAG receipts.

## Owner local config (2026-10-02)

The owner confirmed "only Synapse, and only the models provided by Synapse". The owner's global OpenCode config now has `enabled_providers: ["synapse"]`, the OpenRouter, Zhipu and Sakana providers removed (with their credentials), the Synapse model list set to the 8 live models plus `auto`, `model`/`small_model` = `synapse/auto`, and agents `sol`, `glm`, `coder`, `gemini` remapped from removed models to `synapse/auto`. The owner is to revoke the removed providers' credentials and delete the local backup of the old config.

## Knowledge record

Standards used by earlier workstreams this session apply: `WEBSTA-001-CODING-STANDARDS`, `WEBSTA-001-SECRETS-MANAGEMENT-STANDARDS`, `WEBSTA-001-DOCUMENTATION-STANDARDS`. Each agent records its own RAG query.

## Project receipt

`opencode Delivery` (#16): #71 item `260630859` (In Progress, Current, P1), #72 item `260630987` (In Progress, Current, P3), #73 item `260631066` (Planned, Roadmap, P2). Priorities assessed by an independent reviewer (`ornith-1.0-35b`). Writer: program director.

## Review ledger

One independent reviewer per workstream, 4-cycle budget. Each line: the cycle, the commit reviewed, the result.

| WS | Cycle 0 | Cycle 1 | Cycle 2 | Cycle 3 | Integrated |
|---|---|---|---|---|---|
| WS-1 #71 | `ed26ea57c6`: not clean (stalled body hang, allowlists) | `4d6b3d365e`: not clean (saved-model fallback sent no model) | `30f60e4f03`: not clean (no saved model sent no model) | `ff4d753acc`: **clean** | yes, no drift |
| WS-1b #74 | `07621eb61e`: not clean (refresh race) | `b0be39d093`: not clean (spent refresh token reused; no startup timeout) | `83c4d7ef29`: not clean (token reuse after second refresh; abort mid-rotation) | `c84f564173`: **clean** (startup refresh removed) | yes, no drift |
| WS-2 #72 | `f8ec25f7e6`: not clean (detached HEAD counted merged; delete order; symref) | `504d534579`: not clean (amend false positive; ignored files deleted) | `d99f24d38b`: **clean** | — | yes; overlap with WS-1 in `core-session.ts` is additive |
| WS-3 #73 | `db5a2d0ba7`: not clean (closed runs stay running; served model never real) | `4e67b747b4`: not clean, Lows (lock slows tools; future-dated lock; takeover race; orphan locks) | `675799c7fa`: not clean, Lows (stale error label; report not flushed) | `fdcb6951d5`: not clean, Lows (relink log label; shutdown flush order); budget spent, both fixed by the director at integration (`864d9ec2e0`) | yes |
| WS-4 skill | `466ed63d`: not clean (`oc_answer` missing `kind`; no review registration; Lows) | `8e3f82faf9`: content clean; reviewer gate open (CodeRabbit rate-limited) | — | — | PR Alterspective-IO/Alterspective-Intelligence#1270, merges after #77 |
| Combined (#77) | `864d9ec2e0`: not clean, Lows (close lock not re-checked before the POST; local paths in this plan; five doc claims) | fixed by the director (see below) | — | — | — |

Bridge suite on `delegate-ops` after merging WS-1 and WS-2 (before WS-1b, which changes only `packages/opencode`): 1091 pass, 25 skip, 0 fail; bridge typecheck exit 0. Plugin suite on `delegate-ops` after WS-1b (`packages/opencode`, `bun test test/plugin`): 380 pass, 0 fail; `tsgo --noEmit` exit 0.

Bridge suite after all four workstreams and the integration fixes: 1143 pass, 25 skip, 0 fail; typecheck exit 0.

Open Lows carried to the PR: WS-2 allowlist matches at any folder level (description to say so); WS-1b cache read-modify-write not atomic (self-heals); a chat that stops waiting sends the expired token once (one 401). Follow-ups filed: #75 (two processes can spend the same Synapse refresh token), #76 (`oc_report` cannot see which model `synapse/auto` routed to). Accepted limit: a rare stale-lock takeover race in the task-record store can lose one count (logged as `lock_relink_failed`).

## Next actions

1. Merge #78 (this evidence); then close #71, #72 and #73 with a link to it.
2. #74: keep open until the plugin's live fetch is observed (after a chat renews the owner's Synapse sign-in).
3. Skill: merged (Alterspective-IO/Alterspective-Intelligence#1270, `f068af18`); close its issue once `rag_match_skills` returns it; then add the stash and failed-check rules from #77's last review.
