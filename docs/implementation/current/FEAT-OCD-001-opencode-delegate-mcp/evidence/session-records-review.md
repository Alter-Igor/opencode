# #53 — deleted session host records

Base: `f20d17082ec9da05a7e02ac3cf95571f98cdd913`. Worktree: `C:\GitHub\opencode---session-records`.

`oc_list_sessions` previously read records but never removed them. Its newest-200 display and first-20 presence checks also left older records out of maintenance. The source trace confirmed that only failed-start `discard()` called `removeHostState()`.

The cleanup page now runs after a healthy list. It reads at most 100 record files and checks at most 20 sessions, sharing the direct-presence-read budget with missing-row display. A saved filename cursor advances past live, foreign, damaged and failed records and wraps. The page has a five-second budget; each API/clone probe gets at most one second. A timed-out check keeps the record.

A direct 404 is only half the deletion proof. A separate box probe must confirm the parent is accessible and both `test -e` and `test -L` are false. Distinct exit codes keep shell and Docker errors from meaning absent. The host file must be a regular non-link, and its full bytes and file identity are read again before unlink. The clone is never removed by maintenance. A surviving clone keeps the host base/repo needed by `collect()`. The fix does not expand adoption of deleted sessions after restart. The display's existing all-record read and newest-200 result cap are unchanged.

## Tests and review

- Tests first, work queue PID 98996: 8 passed, 2 failed. The deleted record remained; an old record beyond 200 remained after 14 list/restart calls.
- First green, PID 47420: 37 tests passed in pruning/session/ownership tests.
- Expanded tests, PID 104480: 15 pruning tests passed, including changed-record preservation, host links, damaged-page progress, concurrent list calls, and real Git collection after a cached session is deleted. The following typecheck found two fixture-only type errors; both were corrected, and PID 28752 typecheck passed.
- Real Linux shell proof, PID 75088: absent clone, existing folder, dangling link, missing parent and unreadable parent checks all passed. The initial shell harness omitted `docker run -i`; its empty output failed JSON parsing and is not counted as proof.
- Independent root source review: no confirmed blocker; requested an actual server test with a missing clone directory before final approval.
- The same PID 75088 then ran the actual runtime/server proof, exit 0. `GET /session/<id>?directory=<removed-clone>` returned 404, the actual list tool removed its host record, cached collection before clone removal succeeded, and a dangling clone link kept its record. Project `ocd-prune-42b20f6d` was removed with `compose down -v`; a readback found no owned containers. Scratch evidence: `C:\Users\IGORJE~1\AppData\Local\Temp\ocd-prune-live-CYNbqC`. Scripts: `spike/prune-record-proof.ts` and `spike/prune-session-live.ts`.
- Root accepted the final source and both proof scripts after reading the API deadline path, parser, list wiring and tests. No remaining actionable finding. The root read the live proof receipts but did not personally rerun them.
- Full bridge suite: 65 files across 17 serial light-lane jobs, each at most four files. 883 passed / 25 opt-in or platform skips / 0 failed. Per-batch files and PIDs: [session-records-tests.json](session-records-tests.json). The first version-test batch failed because its assertion fixed the old package version; it now uses the same package-version import as PR #61, and its retry passed (PID 7240).
- Final bridge typecheck: `bun run typecheck`, PID 82480, exit 0. The dedicated root frozen-lockfile install passed (PID 89000). Lint passed (PID 81732): 0 errors / 354 warnings against 353 on the base. The new warning is `consistent-return` in the new `snapshot()` helper; both guard paths return undefined and the success path returns the checked snapshot. Repo-wide typecheck is also enforced by the pre-push hook; its delivery receipt belongs in the PR.
- Secret check: Gitleaks scanned an export of all 16 changed or new files, PID 26468, exit 0; no leaks found. `git diff --check` passed.
- Docker readback after the isolated live proof found zero containers, volumes and networks labelled with project `ocd-prune-42b20f6d`.

Reviewed source SHA-256 values (unchanged after root review):

- `src/supervisor/workspaces-prune.ts`: `686489A97E90474EC30BABDD39404DF6EEE79D4F346CDB2190CBF706539C29B0`
- `src/tools/sessions-list.ts`: `F65AAA4D3B3BD2896D35149374322AD9CD5E98EE762C6C03484B7B2F411A7FA6`

No owner session record was used in these tests. No merge or production change is claimed. PR delivery follows #55.
