# Independent token recovery review

Date: 2026-10-02 (Australia/Sydney). Reviewer: separate Codex review agent; did not write the token recovery implementation or its new recovery tests.

**Verdict:** no further blocking findings in the reviewed changes. The earlier combined storage/state failure is resolved in the tested state below.

## Reviewed state

Base HEAD: `f20d17082ec9da05a7e02ac3cf95571f98cdd913`.

Scope, relative to `alterspective/delegate-mcp/`:

| File | SHA-256 of the reviewed working file |
| --- | --- |
| `src/synapse/token-manager.ts` | `8d74f6c25d308750b23333f170fcbe956ffb34709f50358ff3c6f254628135cc` |
| `src/synapse/refresh.ts` | `d0b2a376aa39f48c7a3e79cdf4591bf0b18f708c929f833b3e65d0e1cc1c2ac9` |
| `src/synapse/secret-store.ts` | `72108e150429f087d8f5f70f6aadad95d7a0b1f0fb9d56f5c8402b92b16c100f` |
| `test/synapse-recovery.test.ts` | `78c95197b150097009e9220a7db1f91a08c671c3ac0a8213a0257651a9de7d47` |

Final reviewed HEAD: `105af94e17a4a3e89c4ef850383d2b066225b95e`. The final review rechecked the lint cleanup: native `Error`/`code` narrowing in the secret store; bound saved fixture methods; `URLSearchParams` narrowing in test assertions. No contract changed and no new blocking finding was found.

SHA-256 of the three tracked source files' Git diff: `21588fb855d467aa4a6b7e47b1a282be390d0f84e393af33429e15d73f91bc2f`.
Calculated from `git -c core.autocrlf=false diff --no-ext-diff --binary f20d17082e -- alterspective/delegate-mcp/src/synapse/token-manager.ts alterspective/delegate-mcp/src/synapse/refresh.ts alterspective/delegate-mcp/src/synapse/secret-store.ts`, with output lines joined by LF, one final LF, and UTF-8 encoding. The separate test file hash binds the recovery test to this receipt.

## Findings checked again

- The rotated refresh token is retained before include/state publication (`token-manager.ts:143`). Filesystem failure after upstream rotation no longer loses the replacement by writing the include first.
- The earlier review found that simultaneous secret-store and state-file failure could still lose the in-memory replacement on the next tick. `unpublishedAt` now keeps it through missing or repaired older state (`token-manager.ts:171`), while a newer successful sign-in supersedes it.
- The follow-up review found that clearing memory before writing recovery state could break recovery when the secret store healed first. Memory is now cleared after the recovery-state write succeeds (`token-manager.ts:193`). Both missing-state and older-state tests cover that repair order.
- Non-missing filesystem errors from the secret store now propagate into retry handling. Only `ENOENT` means no saved token.
- A failed front reload is retried without rotating again or waiting for the new token's renewal point. Retry state preserves the pending-token marker.

The accepted clock-skew/equal-timestamp edge was not reopened. No production service or real owner token was used in this review.

## Observed validation

The reviewer independently ran the recovery test through the work queue: **9 pass, 0 fail, 27 assertions**; Bun `1.3.14`, queue child PID `96820`, exit `0`. The final lint-cleaned state was independently rerun with the same result, queue child PID `105012`, exit `0`. This covers real local filesystem failures with fake upstream and Docker responses. It is not a live Keystone/Synapse test.

```powershell
bash -c '"<work-queue>" run --lane light -- "C:/Windows/System32/cmd.exe" //d //c "cd /d X:\opencode---delegate-hardening\alterspective\delegate-mcp && bun test --timeout 30000 test/synapse-recovery.test.ts"'
```

`git diff --check` passed for the three source files. Full package suite, typecheck, lint and live-image validation remain part of the parent delivery checks; this receipt does not claim them.
