# PR #58 — Fresh review and recovery fixes

Reviewed range: `77f722df52..f20d17082e`. Fix base: `f20d17082ec9da05a7e02ac3cf95571f98cdd913`.
Date: 2026-10-02 (Sydney). Issues: [#59](https://github.com/Alter-Igor/opencode/issues/59), [#60](https://github.com/Alter-Igor/opencode/issues/60). Reviewer: Codex; separate proxy reviewer and token-fix reviewer: `/root/proxy_review`.

Four Medium findings were confirmed twice before repair. No new Critical or High finding was established in this review. Line numbers below refer to the reviewed base, not the fix.

| Severity | Source | Reproduction | Second check and result |
|---|---|---|---|
| Medium | `alterspective/delegate-mcp/src/synapse/secret-store.ts:55` | Make the refresh-file path a directory. The real filesystem read fails, but the old store returns no token; renewal reports needs-sign-in. | Traced `readRefreshToken` to `failClosed`, then ran a regression against the old code. Only ENOENT now means missing; other read faults retry. |
| Medium | `alterspective/delegate-mcp/src/synapse/token-manager.ts:143` | Return a rotated token from the refresh endpoint while the front include cannot be written. The old token has been consumed, but the replacement reaches neither the store nor memory. | A failing test and caller/error-path review confirmed the loss. The fix keeps the replacement before publication. Tests also cover simultaneous store/state failure, partial repair, and a later sign-in superseding it. |
| Medium | `alterspective/delegate-mcp/src/synapse/refresh.ts:38` | Refresh succeeds but the reload fails. Advance one 15-second tick while the new token is not due for renewal. The old code makes no second reload attempt. | Counted reload/refresh calls in a failing test and traced the early fresh return. Failed loads now retry without another refresh grant. |
| Medium | `alterspective/delegate-mcp/docker/front/front-reload.sh:72` and `src/synapse/report.ts:65` | Pause the exact nginx master PID, change a dummy auth include, and run the old helper. It returns success and records the new hash while a worker still serves the old config. | The real-nginx result below agrees with nginx's documented asynchronous reload behavior. A disk dump also reports the new file while old workers remain active. The fix waits for a unique worker reply and reads checked immutable copies. |

The original proxy result was:

```json
{"reloadExit":0,"recordMatchesNewFile":true,"diskDumpMatchesNewFile":true,"before":"old-config","servedWhileMasterPaused":"old-config","afterResume":"new-config"}
```

This proved false acknowledgement. It did not prove that an attacker widened the route set. See nginx's [reload behavior](https://nginx.org/en/docs/control.html) and [command switches](https://nginx.org/en/docs/switches.html): signalling and dumping configuration are different from a worker acknowledging a load.

## Fix review

The separate reviewer found one further fault in the first token fix: simultaneous secret-store and state publication failure could discard the only rotated token on the next tick. The final fix retains an unpublished adoption in memory until recovery state is written; a newer sign-in supersedes it. [Independent review receipt](independent-token-recovery-review.md).

Root reviewed the proxy fix. Its first content-hash-only marker could be answered by an old worker when the same content was requested again. A second live test confirmed that case. Every reload now has a random attempt ID; cleanup waits for that new ID. A timeout retains the checked files so a late master read cannot use changed host input or missing files.

The accepted PR #58 residuals remain: the box can fill Docker volumes; the host holds a DPAPI refresh token under owner decision D-4; token adoption retains the accepted clock-skew edge; header-drop assurance remains config-level. No production config was changed. This work does not claim to close #49, #55 or #53.

## Validation

All tests and typechecking used the owner's work queue. Bridge tests ran in light-lane batches of at most four files, from the bridge package, with `bun test --timeout 30000`.

- Full package run before the 0.1.1 version bump: **879 pass, 0 fail, 25 skip**, across 66 files. The skips include the opt-in live suite and the Windows symlink test. The separate live run below exercised the opt-in suite. The final focused 39-test run missed a hardcoded version expectation; the PR #61 follow-up below records its failure and repair.
- Bridge typecheck: `bun x tsc --noEmit -p .`, exit 0.
- Final lint: `bun x oxlint --format json alterspective/delegate-mcp`, exit 0, **0 errors and 356 warnings**. The same command on base reported 353 warnings. Four newly reported warnings concern awaiting Bun's `.rejects` assertions (typed as non-thenable); those awaits are retained so asynchronous failures are observed. Other new lint warnings were fixed. This is not a warning-free lint result.
- After the final error-type guard, test lint cleanup and version update: **39 pass, 0 fail** across recovery, manager, filesystem retry and CLI tests; typecheck passed again.
- Live egress: **22 pass, 0 fail**. `OCD_LIVE_EGRESS=1`, `OCD_LIVE_BOX_IMAGE=opencode-delegate-box:1.18.31-bc1a3343c278`. The test rebuilt front from this worktree, started its real Compose entrypoint, probed it from Node and the unchanged box image, and cleaned up its scratch project. No owner credentials were used. The box binary itself was not changed or rebuilt for this review fix.
- Real nginx reload proof: `spike/review-reload-proof.ts`, with `OCD_RELOAD_PROOF_IMAGE=opencode-delegate-box:1.18.31-bc1a3343c278-front`. The script runs the changed helper against real nginx in an isolated, networkless container with dummy values. The container was removed. Output:

```json
{"reloadExit":0,"waitedForWorker":true,"markerStayedOldWhilePaused":true,"before":"old-config","servedWhileMasterPaused":"old-config","afterSourceChangedAndResume":"new-config"}
{"timeoutExit":7,"servedAfterTimeout":"new-config","lateLoadAfterSourceChanged":"old-config"}
{"identicalContentWaitedForNewWorker":true}
```

The exact queue form was:

```text
"<work-queue>" run --lane light -- "C:/Windows/System32/cmd.exe" //d //c "cd /d X:\opencode---delegate-hardening\alterspective\delegate-mcp && bun test --timeout 30000 test/synapse-recovery.test.ts"
```

On this machine it is invoked through native Git Bash from PowerShell so `cmd.exe` receives normalized switches. The runner remains the first command inside Bash. The live egress build used the heavy lane.

No visual check applies to these CLI/proxy changes. No merge, production promotion or owner-box restart is included in this evidence.

## PR #61 follow-up: a killed reload helper

[CodeRabbit comment 4156609197](https://github.com/Alter-Igor/opencode/pull/61#discussion_r4156609197) identified a stale directory lock at `front-reload.sh:83–85` in `fd41f85fea8cead63492b4b5ccdc5dfa66b9f659`. This is a Medium availability fault. First, the source trace showed that `SIGKILL` cannot run the `EXIT` trap that removes the directory. Second, the real-nginx proof paused its own master, started one helper, rejected a competing helper, killed the exact first helper PID, and retried. Queue PID 39744 failed as expected:

```json
{"whileOwnerRunning":8,"killedOwnerExit":137,"retryAfterOwnerDeath":8}
```

The fix holds a nonblocking `flock` on descriptor 9 through the worker reply. It leaves the lock file in place so every caller locks the same inode. Both directory-removal paths were removed, including the staging-failure path in the suggested patch. The [Linux lock contract](https://man7.org/linux/man-pages/man2/flock.2.html) says the lock ends when all inherited descriptors close. A short-lived helper child may delay release until that child exits; the regression allows that bounded wait. The Dockerfile explicitly installs [Alpine's flock package](https://pkgs.alpinelinux.org/package/v3.23/main/x86_64/flock).

Queue PID 102312 built the pinned Dockerfile as `ocd-review-flock:pr61`, image digest `sha256:76b384b042762d40d92017d683a508de6e7fcc22363ce600e1b56d7216c194ba`. It installed `flock 2.41.6-r1`. Queue PID 78304 passed the same real-nginx proof, including the existing delayed-load, changed-source, timeout and identical-content cases:

```json
{"whileOwnerRunning":8,"killedOwnerExit":137,"retryAfterOwnerDeath":0}
{"stageFailureExit":6,"lockFileKept":true,"retryAfterStageFailure":0}
```

The proof uses `spike/review-reload-proof.ts` with `OCD_RELOAD_PROOF_IMAGE=ocd-review-flock:pr61`. It owns a networkless, read-only scratch container, has no host mounts or real credentials, and removes that container in `finally`. The owner box was not changed. The root agent independently reviewed the descriptor lifetime, unchanged inode, staging error path and exact-PID kill proof; it found no blocker.

Final verification on the unchanged base `f20d17082ec9da05a7e02ac3cf95571f98cdd913`:

- Windows initially failed five shell cases because Git Bash has no `flock`. Those cases now require both `sh` and `flock`; no fake lock was added. All **7 shell tests passed** in Linux using the existing box's Bun and real `flock`, a read-only package mount, no network and a temporary `/tmp` (queue PID 82648).
- The first full rerun caught the old `0.1.0` expectation in `tools-core-runtime.test.ts`; the package had already moved to `0.1.1`. The expected prefix now comes from `package.json`. No runtime version code changed.
- The final full rerun passed **874 tests, 0 failed, 30 skipped**, across all 66 files in 17 batches of at most four files (queue PID 51972). The five extra skips above were exercised separately in Linux. Bridge `bun run typecheck` also passed. Lint passed with **0 errors and 356 warnings**, unchanged from the earlier receipt.
- The live route suite rebuilt front and passed **22 tests, 0 failed** (queue PID 76180). It used the unchanged `opencode-delegate-box:1.18.31-bc1a3343c278` box image. The scratch Compose project was removed.

Every build and check used the work queue. The full-run command list and output are `<local path>` and `<local path>`. The live proof's exact command inside the PowerShell-to-Git-Bash wrapper was:

```text
"<work-queue>" run --lane light -- "C:/Windows/System32/cmd.exe" //d //c "cd /d X:\opencode---delegate-hardening\alterspective\delegate-mcp && set OCD_RELOAD_PROOF_IMAGE=ocd-review-flock:pr61&& bun spike/review-reload-proof.ts"
```

RAG returned no useful lock-specific lesson; the lessons README was checked. The correction was recorded in Synapse Coder as candidate `8c431934-027d-48b1-8255-d5096288b455`; it was not promoted. README, changelog and technical design describe the new recovery behavior. No visual check applies to this shell/proxy change.

## PR #61 follow-up: fail each proof assertion

[CodeRabbit comment 4157442306](https://github.com/Alter-Igor/opencode/pull/61#discussion_r4157442306) found a Low fault in the proof runner. A failed non-final command in an `&&` list does not trigger shell `set -e`. The same pattern also appeared in the older worker and timeout assertions. The observed JSON above remains evidence, but the runner could return success with a wrong early field.

A fault check read the actual assertion lines and supplied a wrong value for each of their 14 fields, one at a time. Before the fix it reported **9 masked failures** (queue PID 36584, exit 1). Each assertion now has its own line. The same check reported **0 masked failures** (queue PID 54568). That queue job then reran the full real-nginx proof against `ocd-review-flock:pr61`: all five result records matched the expected values, cleanup succeeded, and bridge typecheck passed. A separate agent reviewed every changed assertion and the runner's error and cleanup paths; no blocker remained. Runtime source and the container image did not change. The fault driver is `<local path>`.

## PR #61 follow-up: retry only transient reload failures

An independent review of head `208ff271f2` found one Medium and two Low faults:

- **Medium:** the renewal tick retried the front reload every 15 seconds after any result other than `reloaded`, including `front_not_running` and `config_changed`. Neither clears by itself, so each bridge ran `docker exec` and `docker inspect`, rewrote state and logged a warning on every tick, forever. Now only front-reload exits 4-8 while front runs are retried on the timer, after one tick and then doubling, at most 5 minutes apart. `lastReload.failures` counts them; success resets it. A new token still reloads. A box start needs no bridge reload: the entrypoint's `front-reload --start` publishes the current files before nginx starts.
- **Low:** exit 4 left `current.conf` pointing at the config `nginx -t` refused. The script now restores the previous target, or removes the file if there was none.
- **Low:** exits 7 and 8 were reported as `config_invalid`. They are now `unverified` (no worker reply in time) and `busy` (another reload running). `oc_login` words them separately; doctor prints the result as recorded.

Test first, with Bun `1.3.14` from `alterspective/delegate-mcp`:

- `bun test --timeout 30000 ./test/synapse-recovery.test.ts` before the fix: **9 pass, 4 fail**. The two no-retry cases saw 9 reloads in 9 ticks (expected 1); the mapping and backoff cases saw `config_invalid` (expected `unverified`). After the fix: 13 pass, 0 fail.
- `test/synapse-front-reload.test.ts` needs `sh` and `flock`, so it skips on Windows. For a local check only, a fake `flock` that exits 0 was put first on `PATH` (not committed). Against the old script the restore case failed (1 fail, 6 pass); with the fix it passed (7 pass). Real `flock` in Linux was not run for this change.

Final checks:

- `bun test --timeout 30000 ./test/*.test.ts`: **878 pass, 0 fail, 30 skip**, 3,470 assertions across 66 files.
- `bun run typecheck`: exit 0.
- `git diff --check`: clean.

Not run: lint, the live route suite, the real-nginx proof, and any Docker or live Keystone test. No running container was touched.

## Documentation and rules

README, package changelog/version, technical design, issue log and index were updated with the change (PDOC-LOC-01, VER-SRC-01, VER-LOG-01). The bridge is a single-purpose local tool; its operational guide is the package README. Existing fork-wide gaps G-1 through G-4 remain tracked under #41; this patch does not create a Project board or rewrite the fork documentation suite.

RAG was connected and searched before source work. No useful subject-specific AILES lesson was returned; `Practice/AI/lessons/README.md` was read. Local `code-review`, `fix`, `project-manager`, `commit-pr` and `docs-update` skills guided the work. Checks followed AIMETH-010, TST-FAL-01 and TST-VAL-01. The product documentation standard was fetched with clean revision status. The docs received a plain-language pass (DOC-HF-04).
