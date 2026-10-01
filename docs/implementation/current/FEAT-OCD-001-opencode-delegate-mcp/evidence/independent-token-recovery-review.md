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
| `src/synapse/secret-store.ts` | `98e7dcef9df1d66f68794e878c08762a7021e06ec44c17f2bd84366542e24a06` |
| `test/synapse-recovery.test.ts` | `2e829f3fbffe7e8b79e90c65669a01114cc136d45b440bdebb03947c2f5ce9f9` |

SHA-256 of the three tracked source files' Git diff: `efd23260a45fa5a8a55dae61e55443ffa70c2c6f3820b86e00a2ffbc52ccfd55`.
Calculated from `git -c core.autocrlf=false diff --no-ext-diff --binary -- src/synapse/token-manager.ts src/synapse/refresh.ts src/synapse/secret-store.ts`, with output lines joined by LF, one final LF, and UTF-8 encoding. The recovery test was untracked when reviewed, so its separate file hash binds that test to this receipt.

## Findings checked again

- The rotated refresh token is retained before include/state publication (`token-manager.ts:143`). Filesystem failure after upstream rotation no longer loses the replacement by writing the include first.
- The earlier review found that simultaneous secret-store and state-file failure could still lose the in-memory replacement on the next tick. `unpublishedAt` now keeps it through missing or repaired older state (`token-manager.ts:171`), while a newer successful sign-in supersedes it.
- The follow-up review found that clearing memory before writing recovery state could break recovery when the secret store healed first. Memory is now cleared after the recovery-state write succeeds (`token-manager.ts:193`). Both missing-state and older-state tests cover that repair order.
- Non-missing filesystem errors from the secret store now propagate into retry handling. Only `ENOENT` means no saved token.
- A failed front reload is retried without rotating again or waiting for the new token's renewal point. Retry state preserves the pending-token marker.

The accepted clock-skew/equal-timestamp edge was not reopened. No production service or real owner token was used in this review.

## Observed validation

The reviewer independently ran the recovery test through the work queue: **9 pass, 0 fail, 27 assertions**; Bun `1.3.14`, queue child PID `96820`, exit `0`. This covers real local filesystem failures with fake upstream and Docker responses. It is not a live Keystone/Synapse test.

```powershell
& "C:\Program Files\Git\bin\bash.exe" --noprofile --norc -c '"C:/Users/IgorJericevich/Desktop/This Rig/scripts/automation/work-queue/bin/thisrig-work-queue.exe" run --lane light -- "C:/Windows/System32/cmd.exe" //d //c "cd /d X:\opencode---delegate-hardening\alterspective\delegate-mcp && C:\Users\IgorJericevich\.bun\bin\bun.exe test --timeout 30000 test/synapse-recovery.test.ts"'
```

`git diff --check` passed for the three source files. Full package suite, typecheck, lint and live-image validation remain part of the parent delivery checks; this receipt does not claim them.
