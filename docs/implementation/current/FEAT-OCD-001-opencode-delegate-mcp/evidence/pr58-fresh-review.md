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

- Full package run: **879 pass, 0 fail, 25 skip**, across 66 files. The skips include the opt-in live suite and the Windows symlink test. The separate live run below exercised the opt-in suite.
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
"C:/Users/IgorJericevich/Desktop/This Rig/scripts/automation/work-queue/bin/thisrig-work-queue.exe" run --lane light -- "C:/Windows/System32/cmd.exe" //d //c "cd /d X:\opencode---delegate-hardening\alterspective\delegate-mcp && C:\Users\IgorJericevich\.bun\bin\bun.exe test --timeout 30000 test/synapse-recovery.test.ts"
```

On this machine it is invoked through native Git Bash from PowerShell so `cmd.exe` receives normalized switches. The runner remains the first command inside Bash. The live egress build used the heavy lane.

No visual check applies to these CLI/proxy changes. No merge, production promotion or owner-box restart is included in this evidence.

## Documentation and rules

README, package changelog/version, technical design, issue log and index were updated with the change (PDOC-LOC-01, VER-SRC-01, VER-LOG-01). The bridge is a single-purpose local tool; its operational guide is the package README. Existing fork-wide gaps G-1 through G-4 remain tracked under #41; this patch does not create a Project board or rewrite the fork documentation suite.

RAG was connected and searched before source work. No useful subject-specific AILES lesson was returned; `Practice/AI/lessons/README.md` was read. Local `code-review`, `fix`, `project-manager`, `commit-pr` and `docs-update` skills guided the work. Checks followed AIMETH-010, TST-FAL-01 and TST-VAL-01. The product documentation standard was fetched with clean revision status. The docs received a plain-language pass (DOC-HF-04).
