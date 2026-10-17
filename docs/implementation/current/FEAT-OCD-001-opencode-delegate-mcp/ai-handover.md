# FEAT-OCD-001 — AI handover

## Session summary

**Date:** 2026-10-17
**Phase:** Testing / completing (#186)
**Progress:** code done and reviewed; full suite and merge left.

## Current status

Branch `delegate-mirror-check-followups` (worktree `C:\GitHub\opencode---delegate-mirror-check-followups`) holds the #186 follow-ups to the oc_collect cache-address check, pushed to origin. No PR is open yet. Fresh QA passed (round 3) and the architect said ALIGNED, both on `e8fc2f60d6`. The full suite was stopped by Claude Code for low memory before it finished, so it has not passed on that head.

## Files changed on this branch

- `alterspective/delegate-mcp/src/supervisor/workspaces.ts` — `mirrorAddressChanges` returns `{ files, reason? }`. New `grepPathspecs` (an allowlist of plain path parts) and `checkFailure`. `collect` adds `mirrorCheckError`, and the trace logs it.
- `alterspective/delegate-mcp/src/tools/collect-warnings.ts` (new) — one place builds the collect warnings.
- `alterspective/delegate-mcp/src/tools/collect.ts`, `land.ts`, `verify.ts` — all three report `hostExecutableChanges` and `mirrorAddressFiles`. `oc_land` adds the warning sentences to a later step's error.
- `alterspective/delegate-mcp/src/shared/contracts.ts` — `mirrorCheckError?: string`.
- Tests:
  - `test/workspaces.test.ts`: real git; `git diff` / `git grep` fail and time out; narrowed vs whole-tree grep; raw names built with plumbing (backslash, non-UTF-8, the host repo path); `.` / `..` parts refused at fetch.
  - `test/tools-wave3.test.ts` and `test/tools-core-result.test.ts`.
- Docs: `docker/caches/README.md`, `README.md`, `technical-design.md` §4, `CHANGELOG.md` (Unreleased).

## Done

- [x] #186 items 2–8 (item 1 was fixed in #185).
- [x] Fresh QA: round 1 FAIL (fixed in `b2f28467f0`), round 2 FAIL (fixed in `e8fc2f60d6`), round 3 PASS on `e8fc2f60d6`.
- [x] Architect (`synapse/moonshotai/kimi-k3`, standing in because gpt-6-astra was not listed): ALIGNED on `9bbdeefb00` (its README fix), then ALIGNED on `e8fc2f60d6`.
- [x] Typecheck clean; oxlint on changed files 0 errors.
- [x] Follow-up filed: #188 — cache check reads clean under forced git colour.

## Next, in order

1. Run the full suite in `alterspective/delegate-mcp` with nothing else running: `bun test`. Earlier mixed runs failed only in `defaultSupervisorDeps: image identity` (each ~5 s, the default per-test timeout) and some 60 s close/cleanup timeouts, while other runs were going. If those fail again, run that file alone on this branch and on `dev` to see whether they are pre-existing.
2. ~~The head moved after the gates~~ Done: the architect re-gated `444577ec8e13` (docs-only handover commit) and confirmed ALIGNED — ARCH-GATE-02.
3. Open the PR: body draft at the session scratchpad `pr186.md` (rewrite if missing). Title `fix(delegate-mcp): cache-address check follow-ups (#186)`. Then pr-loop → integrate → merge with `--match-head-commit`. The owner approved this merge on 2026-10-17.
4. After merge: `aio repo-worktree close --repo C:\GitHub\opencode---delegate-mirror-check-followups`, then delete the remote branch.

## Blockers

- The full suite needs a quiet PC (low memory killed the last run). Nothing else.

## Critical context

- Narrowing `git grep` to pathspecs is only safe for plain names. Git rewrites some names it is handed back, even with `--literal-pathspecs`. See ai-memory.md.
- Never stash or edit files while `bun test` runs in the same worktree. Stopping the shell (TaskStop) leaves the bun child running on Windows.
