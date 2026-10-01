# Observer retrospective switch — #55

Date: 2026-10-02. Branch: `observer-profile`. Base: `f20d17082ec9da05a7e02ac3cf95571f98cdd913` (`origin/dev`, fetched before validation).

The delegate box sets `OPENCODE_DISABLE_SESSION_RETROSPECTIVES=1`. `finalizeSessionRetrospective` clears that session's pending records and returns `null` before creating a retrospective, writing its JSON file, or calling the Keystone audit endpoint. The existing caller ignores the nullable result. With the flag unset or `0`, the fork keeps its existing behavior.

The flag also stops retrospective files in the box, but it does not stop diagnostic logs or learnings. [#50](https://github.com/Alter-Igor/opencode/issues/50) remains open for the wider workspace-output issue. No authentication or network route was added.

## Verification

Every install and test command uses the This Rig work queue. Bridge test batches contain at most four files. Validation claims follow `TST-VAL-01`.

| Check | Observed result |
| --- | --- |
| Box setting regression before the compose change | `bun test --timeout 30000 test/supervisor-compose-env.test.ts`: 2 passed, 1 failed; the new flag was absent. |
| Same regression after the compose change | 3 passed, 0 failed; 51 assertions. Includes the reserved environment-name check. |
| Source review | Root agent found no blocker in the guard, Compose wiring, or final test diff. Its request for per-test fetch-spy setup/cleanup is included. |
| `git diff --check` | Passed. |
| Package installation | `bun install --frozen-lockfile` passed at the root and bridge package: 4,695 and 99 packages installed. Both local dependency directories exist; lockfiles are unchanged. |
| Observer automated tests | `bun test --timeout 30000 test/plugin/observer.test.ts` from `packages/opencode`: 17 passed, 0 failed; 56 assertions. |
| Full bridge test suite | All 64 test files in 16 batches: 869 passed, 0 failed, 25 skipped. |
| Combined OpenCode test process | `bun test --timeout 30000 --only-failures` stopped making log progress after `test/control-plane/workspace.test.ts` at 17:02:15 UTC. At 17:08 UTC its Bun process was still consuming CPU despite the 30-second test timeout. The exact owned Bun PID was stopped; the job returned exit 1 with no final test summary. This remains unresolved. |
| Isolated workspace tests | The same unchanged test file completed on both changed code (35 passed, 1 skipped, 0 failed; 33.46 seconds) and base code (35 passed, 1 skipped, 0 failed; 47.88 seconds). This does not establish the combined-process stall as a base defect. |
| OpenCode file inventory | All 268 files accounted for: 67 serial batches of at most four files, the separate workspace file, and completion checks for batch 11. Aggregated result: 3,759 passed, 58 skipped, 20 failed. This is not a green full suite. |
| OpenCode base comparisons | All 20 failing cases reproduced on base `f20d17082ec9da05a7e02ac3cf95571f98cdd913`. Named-case checks used the same worktree with the two changed OpenCode files temporarily restored from that commit. No test expectations or configuration were changed. |
| OpenCode type check | `bun typecheck` from `packages/opencode`: passed after adding an explicit null guard in the new test. |
| Bridge type check | `bun x tsc --noEmit -p .` from `alterspective/delegate-mcp`: passed. |
| Repository lint | `bun run lint`: exit 0, 5,458 warnings and 0 errors across 3,519 files. |
| Visual checks | Not applicable: this changes background retrospective output and box configuration, with no rendered control. |
| Target box | Not rebuilt or restarted. No live claim is made. |

The observer tests intercept the fixed audit endpoint with a per-test fetch spy. They check that the disabled path writes no directory and sends no request, while the unset and `0` paths still write the retrospective and dispatch its original request. They also check that disabled finalization releases the session's collected records.

The 20 reproduced base failures are:

| Test file | Cases | Observed failure |
| --- | ---: | --- |
| `test/cli/tui/editor-context-zed.test.ts` | 1 | Windows denies creation of the test symlink (`EPERM`). |
| `test/server/httpapi-sdk.test.ts` | 1 | Project skill text is absent from the fake model request. |
| `test/session/llm-native-recorded.test.ts` | 3 | Recorded requests differ from the fork's prompt instructions and cache-control structure. |
| `test/session/message-v2.test.ts` | 1 | Expected synthetic text is absent. |
| `test/session/processor-effect.test.ts` | 2 | Expected response text is empty. |
| `test/session/prompt.test.ts` | 2 | Subtask error metadata and cancellation expectations fail. |
| `test/session/system.test.ts` | 1 | Skill output is absent. |
| `test/snapshot/snapshot.test.ts` | 2 | Windows denies creation of test symlinks (`EPERM`). |
| `test/tool/external-directory.test.ts` | 1 | Windows path variants produce a different permission glob. |
| `test/tool/read.test.ts` | 1 | The normalized path points to `X:` while the fixture is under `C:`. |
| `test/util/filesystem.test.ts` | 2 | Windows denies creation of test symlinks (`EPERM`). |
| `test/util/glob.test.ts` | 2 | Windows denies creation of test symlinks (`EPERM`). |
| `test/cli/run/run-process.test.ts` | 1 | The SIGINT case reaches its 30-second test timeout on changed and base code. |

The failure comparison uses exact test names; all 20 matched, with none left unclassified. The combined-process stall described above remains unresolved because its standalone workspace check passed on both versions. No unrelated fork test was changed.

## Delivery

Bridge version: `0.1.2`. The changelog preserves `0.1.1`, owned by [PR #61](https://github.com/Alter-Igor/opencode/pull/61). Merge order is #61 then this change; base-sync and revalidation are required after #61 merges. The upstream OpenCode package version stays at `1.18.31`; the box build identity hashes both the observer source and Compose inputs.

Product/operator documentation is updated in the bridge README and package changelog. The technical design and F-R4-01a issue row are updated. No new diagram is needed for the single early-return branch. The documentation wording was checked against `DOC-HF-04` and `PDOC-LOC-01`.

No new reusable lesson was found. `AILES-032` already covers the queue's Git Bash/Windows command boundary; that form was used for the commands here.

## Local validation notes

The two Windows declaration placeholders in `packages/app/src/custom-elements.d.ts` and `packages/enterprise/src/custom-elements.d.ts` were replaced with local hardlinks to `packages/ui/src/custom-elements.d.ts` and marked skip-worktree, per `AGENTS.md`. They are not tracked changes.

Local test logs: `C:\Users\IgorJericevich\AppData\Local\Temp\opencode-observer-profile-checks` (`bridge-01.log` through `bridge-16.log`, `opencode-full.log`, and `lint.log`). The install initially waited for workstation resources; two attempts failed on `queue.lock` and another reached the admission limit. The combined retry completed successfully. No queue controls were changed.

The same local folder preserves `full-suite-process.txt`, both standalone workspace logs, `opencode-inventory.txt`, `opencode-batches.json`, and per-batch stdout, stderr, and result JSON. The process snapshot recorded the full-suite command, wrapper PID 84792, child Bun PID 43728, CPU increasing from 364.625 to 373.281 seconds, and working set increasing from 865,689,600 to 986,529,792 bytes. Only that exact Bun PID was stopped. The isolated baseline check temporarily restored the two changed OpenCode files from the base commit, then restored the exact changed file bytes in a `finally` block.

OpenCode batch 11 reached its 180-second external bound after the first 12 cases in `test/cli/run/run-process.test.ts` passed. The final SIGINT case had not completed, and the other three files had not run. Separate completion checks passed all 26 cases in `runtime.boot.test.ts`, `runtime.queue.test.ts`, and `runtime.stdin.test.ts`. The isolated SIGINT case then reached its own 30-second timeout on both changed code and base code. Filtered-out cases in those two named runs are not counted as skipped tests in the aggregate above.

The first batch driver stopped at its 25-minute checkpoint after batch 53. The completed, incomplete, and remaining file manifests were saved before only batches 54–67 resumed. Baseline comparisons and completion checks were finite serial queue jobs with a 90-second external bound. The combined-run failure and batch-11 bound remain recorded; neither was counted as a pass.

The queue reported surviving test descendants after batch 11, batch 14, and the two SIGINT checks. Exact process identities were recorded in the corresponding `*-owned-descendants.txt` files before only those owned processes were stopped. A final process check found no remaining Bun, Git, Node, or recorded console-host test process matching this worktree. The source and test bytes were restored after every base comparison; the only unstaged diff at that point was this evidence file.
