# Quality loop, iterations 0-14 (2026-10-11..12) — what shipped into 0.5.1 and why

Mandate: 48h improvement loop (owner, 2026-10-11). Ledger: `.handovers/quality-loop-2026-10-11.md` (git-ignored; this file is the durable summary). All merges landed on `dev` under standing owner approval during the account-wide GitHub Actions outage (CI-green gate unavailable; owner directive 2026-10-12: working locally, independent-agent review replaces the GitHub gate). Suite after every change: 1,300+ pass with the failure set byte-identical to the pre-loop baseline on this Windows box (the known `sh`-dependent box tests).

## What changed in the architecture

| Area | Before | After | Commits |
|---|---|---|---|
| Role picks (D4) | blind score-then-id pick could land on Synapse's ghost rows and 404-kill tasks | `taskRole` picks ranked by live suitability, broken by measured serving share, vetoed by the dead firewall; box-offer constrained; never blocks a send | `4a3a978` (#156) |
| Learning boundary | client risked duplicating gateway learning | `opencode-delegate role-quality` machine-checks when Synapse's table is trustworthy; standing deal to delete the client tie-break when `allBaked` fires; outcome rows offered as `synapse-internal` ingest (#1926, comments 6107661227 / 6115079280) | `6162893` |
| Reporting | none | host-only task records (metadata), scorecard + delta CLI, outcomes JSONL export | #154/#155 |
| Observability | text CLIs, hand-armed watcher | branded 4-view dashboard (`oc_dashboard`, §12) + `dashboard` CLI + first-run auto-open; watcher supervisor v3 self-re-arms and publishes `ocd-watch.status.json` | `d3f6002`, `830e89f` |
| Log noise | ~16k repeat lines/day | once-per-kind streak logs; `drop-streak` classes | #158/#159 |
| Self-cleanup | logs grew forever (8 MB/day) | 30-day daily sweep by file name; records/session/hand-off sweeps verified live | `830e89f` |
| Test isolation | interaction fixture wrote into the operator's real home | throw-away fixture home (pattern already used elsewhere); leak removed and verified | `eb531bda` |

Brand compliance (dashboard): WEBSTA-001-UX-QUALITY UX-BRAND-01..08a applied and *proved*, not asserted — used-font probe with mandatory negative control (`spike/font-evidence.ts`, PASS at 1280/380 px per AIRUN-025), token-only colours (test-enforced hex quarantine), paired light/dark renders, hand-drawn outlined vectors (the raster "theme icons" rejected for ICON-001).

## Performance audit (2026-10-12, live measurements — design doc §14)

- Dashboard poll 27 ms/tab/5 s (481 records; scales to ~100 ms at the 2,000 cap; zero idle cost).
- Role-pick history 0.3 ms read, 60 s memoised. `/v1/models` pre-flight ~7 ms (4 s cap, fails open).
- Synapse gateway ≈20 ms per chat (no-model `/v1/models` shell 5-25 ms vs ~240 ms warm 1-token chat): model time dominates; tenant policy is process-cached, selection in-memory, benchmark watcher off-path.
- Bridge additions total: nothing on the model-call path; reporting is fire-and-forget on settled events.
- One measurement batch discarded mid-audit: PowerShell quoting corrupted request bodies (35 ms "results" were the gateway rejecting bad JSON). Caught by noticing the payload, re-run clean — recorded here because "check the artifact, not the exit code" (AILES-032) is the rule the mistake violated.

## Knowledge artifacts

- **AILES-180** merged + reindexed (Intelligence #1484): the font-deferral root cause (rule-as-burden misread; sibling-repo code unindexed by canonical RAG; `rag_search_repos` = mirrored docs only). The query that missed it in October now returns the lesson itself — verified with the repro search.
- Synapse issues: #1921 (listed-but-404, still open upstream — local dead firewall is the interim guard), #1926 (ingest ask pending an answer), #1928/#1929 shipped (their half: pluggable benchmarks + governance; x-task-role routing still inert per live probes).
- Watcher trap recorded: full bun path (Nodist shim), wrapper at `%TEMP%\opencode\ocd-watch-arm.ps1`.

## Still open (for the next session)

- `role-quality` flip → delete the `wins` tie-break term in `rankedForRole` (one small PR; keep dead firewall + box-offer).
- #1926 ingest answer → send the ~480-row 30d batch, conform to their contract.
- First real log sweep fires when the oldest file (bridge-2026-09-30.log) passes its 30-day name-cutoff at a day rollover on 0.5.1 code: ~2026-10-30. Verify by reading the folder, don't assert.
- Worktrees registered via `aio repo-worktree` (brand-dashboard, role-quality, log-retention, fixture-home, loop-docs): close once the owner confirms; `aio repo-worktree close` refuses without a merged PR, and these merged by local mandate — owner `--force` call, never raw `git worktree remove`.
- GitHub Actions outage still needs an owner restore via the Web UI; until then opencodealt EDGE releases do not publish and merges stay owner-approval-based.
