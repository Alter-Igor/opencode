# #53 — deleted session host records

Base: `f20d17082ec9da05a7e02ac3cf95571f98cdd913`. Worktree: a dedicated `session-records` worktree.

`oc_list_sessions` previously read records but never removed them. Its newest-200 display and first-20 presence checks also left older records out of maintenance. The source trace confirmed that only failed-start `discard()` called `removeHostState()`.

The cleanup page now runs after a healthy list. It reads at most 100 record files and checks at most 20 sessions, sharing the direct-presence-read budget with missing-row display. A saved filename cursor advances past live, foreign, damaged and failed records and wraps. The page has a five-second budget; each API/clone probe gets at most one second. A timed-out check keeps the record.

A direct 404 is only half the deletion proof. A separate box probe must confirm the parent is accessible and both `test -e` and `test -L` are false. Distinct exit codes keep shell and Docker errors from meaning absent. The host file must be a regular non-link, and its full bytes and file identity are read again before unlink. The clone is never removed by maintenance. A surviving clone keeps the host base/repo needed by `collect()`. The fix does not expand adoption of deleted sessions after restart. The display's existing all-record read and newest-200 result cap are unchanged.

## Tests and review

- Tests first, work queue PID 98996: 8 passed, 2 failed. The deleted record remained; an old record beyond 200 remained after 14 list/restart calls.
- First green, PID 47420: 37 tests passed in pruning/session/ownership tests.
- Expanded tests, PID 104480: 15 pruning tests passed, including changed-record preservation, host links, damaged-page progress, concurrent list calls, and real Git collection after a cached session is deleted. The following typecheck found two fixture-only type errors; both were corrected, and PID 28752 typecheck passed.
- Real Linux shell proof, PID 75088: absent clone, existing folder, dangling link, missing parent and unreadable parent checks all passed. The initial shell harness omitted `docker run -i`; its empty output failed JSON parsing and is not counted as proof.
- Independent root source review: no confirmed blocker; requested an actual server test with a missing clone directory before final approval.
- The same PID 75088 then ran the actual runtime/server proof, exit 0. `GET /session/<id>?directory=<removed-clone>` returned 404, the actual list tool removed its host record, cached collection before clone removal succeeded, and a dangling clone link kept its record. Project `ocd-prune-42b20f6d` was removed with `compose down -v`; a readback found no owned containers. Scratch evidence: a local temporary folder (not committed). Scripts: `spike/prune-record-proof.ts` and `spike/prune-session-live.ts`.
- Root accepted the final source and both proof scripts after reading the API deadline path, parser, list wiring and tests. No remaining actionable finding. The root read the live proof receipts but did not personally rerun them.
- Full bridge suite: 65 files across 17 serial light-lane jobs, each at most four files. 883 passed / 25 opt-in or platform skips / 0 failed. Per-batch files and PIDs: [session-records-tests.json](session-records-tests.json). The first version-test batch failed because its assertion fixed the old package version; it now uses the same package-version import as PR #61, and its retry passed (PID 7240).
- Final bridge typecheck: `bun run typecheck`, PID 82480, exit 0. The dedicated root frozen-lockfile install passed (PID 89000). Lint passed (PID 81732): 0 errors / 354 warnings against 353 on the base. The new warning is `consistent-return` in the new `snapshot()` helper; both guard paths return undefined and the success path returns the checked snapshot. Repo-wide typecheck is also enforced by the pre-push hook; its delivery receipt belongs in the PR.
- Secret check: Gitleaks scanned an export of all 16 changed or new files, PID 26468, exit 0; no leaks found. `git diff --check` passed.
- Docker readback after the isolated live proof found zero containers, volumes and networks labelled with project `ocd-prune-42b20f6d`.

Reviewed source SHA-256 values (unchanged after root review):

- `src/supervisor/workspaces-prune.ts`: `686489A97E90474EC30BABDD39404DF6EEE79D4F346CDB2190CBF706539C29B0`
- `src/tools/sessions-list.ts`: `F65AAA4D3B3BD2896D35149374322AD9CD5E98EE762C6C03484B7B2F411A7FA6`

No owner session record was used in these tests. No merge or production change is claimed. PR delivery follows #55.

## PR #63 follow-up: cursor persistence

[CodeRabbit comment 4158727609](https://github.com/Alter-Igor/opencode/pull/63#discussion_r4158727609) found a Low result-reporting fault at `src/supervisor/workspaces-prune.ts:77` on head `a6e7b46953295686de86613f1b0e86fea75721c1`. Saving the page cursor could throw after records had already been removed, so the caller received a rejection instead of the removed keys. The list tool caught that rejection and logged a generic warning; its user response did not fail.

The source trace was confirmed with a real filesystem regression. The test creates its own directory at the cursor destination, which makes the file rename fail. Before the fix, queue PID 78296 returned **15 passed, 1 failed** with an EPERM rename error. Cursor writes are now best effort; the existing temporary-file cleanup still runs and the completed removal list is returned. The same test then passed: **16 passed, 0 failed, 50 assertions**, followed by bridge typecheck, queue PID 69216. No existing host record was used.

A separate agent reviewed the two-file code/test diff, the caller and the unchanged deletion guards. No blocker remained. The root reviewed that receipt and ran all 65 bridge test files again, using the same file groups in [session-records-tests.json](session-records-tests.json). The base remained `f20d17082ec9da05a7e02ac3cf95571f98cdd913`: **884 passed, 25 skipped, 0 failed**. Each row below exited 0; the counts do not include the earlier focused run.

| Batch | Queue PID | Passed | Skipped |
| --- | --- | --- | --- |
| 1 | 82572 | 62 | 0 |
| 2 | 8456 | 63 | 0 |
| 3 | 56508 | 33 | 24 |
| 4 | 81812 | 107 | 0 |
| 5 | 98616 | 54 | 0 |
| 6 | 97528 | 66 | 0 |
| 7 | 88440 | 46 | 0 |
| 8 | 27000 | 53 | 0 |
| 9 | 95568 | 23 | 0 |
| 10 | 103440 | 57 | 0 |
| 11 | 88468 | 58 | 0 |
| 12 | 52512 | 38 | 0 |
| 13 | 46284 | 49 | 0 |
| 14 | 61164 | 51 | 0 |
| 15 | 32424 | 56 | 0 |
| 16 | 39920 | 57 | 1 |
| 17 | 68472 | 11 | 0 |

Final bridge lint exited 0 with 0 errors and 354 warnings, unchanged from the prior run (queue PID 103020). The cursor fix does not change the API or clone absence checks, so the prior live proof remains evidence for those unchanged paths. It was not rerun for this host-only error handling change. No merge, owner-box restart or production change was made.

## PR #63 follow-up: independent review findings

An independent review of head `4dd971a825` found four faults. All four are fixed in this change.

| Finding | Severity | Fault | Fix |
| --- | --- | --- | --- |
| 1 | High | All projects under one home share `<home>/workspaces`, but the box and its `sessions` volume come from `OPENCODE_DELEGATE_PROJECT`. A bridge with the same name on another project could see a 404 and an absent clone in its own box and delete the first box's records. | `bindSession` stamps `boxProject` (the compose project) into the record. The sweep skips any record whose `boxProject` differs from its own, including records with none. |
| 2 | Medium | Removed keys were dropped silently inside a list call marked `destructiveHint: false`. | Each removed key is logged at info level with the bridge logger and returned as `prunedRecords`. The annotation is now `destructiveHint: true`. No test or doc asserted the old value. |
| 3 | Low | Check then unlink: a writer could rename a new record over the name in between. | The record is renamed to a unique `.pruning` name in the same folder and checked there (bytes, inode, device, mtime, size). On a mismatch it is put back with a hard link, which never replaces a newer record. |
| 4 | Low | The sweep could pick a session this bridge still tracks in memory. | The list tool passes `ctx.sessions`; tracked sessions are skipped before the checks and again just before the delete. |

Box identity is the project name only. The volume is `<project>_sessions`, so the project names the volume. A recreated volume under the same project has lost the clone anyway. A marker file inside `/sessions` was not added: the box could rewrite it, and it would add a write into the box at bind time.

Tests first. Five new tests were added to `test/workspaces-prune.test.ts`: other project kept, legacy record kept, same project pruned; binding records the project; pruned keys logged and returned, with the annotation; a tracked session kept; a record replaced between the last check and the move restored. Command, from `alterspective/delegate-mcp`:

```text
bun test --timeout 30000 ./test/workspaces-prune.test.ts
```

- Before the fix: **16 passed, 5 failed** (the five new tests).
- After the fix: **21 passed, 0 failed**.

Full checks after the fix, from `alterspective/delegate-mcp`:

```text
bun test --timeout 30000 ./test/*.test.ts   -> 889 passed, 25 skipped, 0 failed (914 tests, 65 files)
bun run typecheck                           -> exit 0
git diff --check                            -> clean
```

Not run for this change: lint, the live Docker proof and the Gitleaks scan. No box or container was started, stopped or restarted.

Limit: only records bound by 0.1.3 or later, by a bridge with the same fixed name and project, are ever pruned. Records from older bridges and from default random `claude-<hex>` bridge names are kept. So #53 is fixed for new records of fixed-name bridges only.
