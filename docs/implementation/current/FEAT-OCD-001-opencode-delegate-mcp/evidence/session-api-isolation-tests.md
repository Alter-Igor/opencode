# #49 validation receipt

Date: 2026-10-02. Worktree: `C:\GitHub\opencode---session-isolation`, branch `session-isolation`, base `f20d17082e`. These results cover the uncommitted implementation in that worktree; they are not a claim about a later commit or merge.

## Bridge suite

All 65 `test/**/*.test.ts` files ran in 17 light-lane batches of at most four files. Every batch returned exit 0. Total: **876 pass, 25 skip, 0 fail**.

| Batch | Test files (under `alterspective/delegate-mcp/`) | Pass | Skip | Fail |
| --- | --- | ---: | ---: | ---: |
| 1 | `test/auth-store.test.ts`, `test/channels.test.ts`, `test/doctor-live.test.ts`, `test/egress-allowlist.test.ts` | 63 | 0 | 0 |
| 2 | `test/egress-caches.test.ts`, `test/egress-compose.test.ts`, `test/egress-doctor.test.ts`, `test/egress-front-paths.test.ts` | 63 | 0 | 0 |
| 3 | `test/egress-live.test.ts`, `test/events-buffer.test.ts`, `test/events-hub.test.ts`, `test/events-lifecycle.test.ts` | 33 | 24 | 0 |
| 4 | `test/events-server.test.ts`, `test/events-sse.test.ts`, `test/events-state.test.ts`, `test/guard-entries.test.ts` | 107 | 0 | 0 |
| 5 | `test/guard-permissions.test.ts`, `test/guard-runtime.test.ts`, `test/handoff-compose.test.ts`, `test/handoff-hygiene.test.ts` | 54 | 0 | 0 |
| 6 | `test/inbox-client.test.ts`, `test/inbox-sidecar-limits.test.ts`, `test/inbox-sidecar.test.ts`, `test/inbox-tools.test.ts` | 67 | 0 | 0 |
| 7 | `test/keystone-ceiling.test.ts`, `test/keystone-set.test.ts`, `test/keystone-tool-deny.test.ts`, `test/login.test.ts` | 46 | 0 | 0 |
| 8 | `test/review-r3-directory.test.ts`, `test/server.test.ts`, `test/session-api-isolation.test.ts`, `test/session-keystone.test.ts` | 28 | 0 | 0 |
| 9 | `test/shared.test.ts`, `test/spawn.test.ts`, `test/supervisor-compose-env.test.ts`, `test/supervisor-docker.test.ts` | 51 | 0 | 0 |
| 10 | `test/supervisor-front-lock.test.ts`, `test/supervisor-identity.test.ts`, `test/supervisor-leases.test.ts`, `test/supervisor-lifecycle-review.test.ts` | 42 | 0 | 0 |
| 11 | `test/supervisor-lifecycle.test.ts`, `test/supervisor-profile.test.ts`, `test/supervisor-replace.test.ts`, `test/synapse-front-reload.test.ts` | 60 | 0 | 0 |
| 12 | `test/synapse-front.test.ts`, `test/synapse-fs-retry.test.ts`, `test/synapse-handoff.test.ts`, `test/synapse-manager.test.ts` | 45 | 0 | 0 |
| 13 | `test/synapse-token.test.ts`, `test/tools-core-cli.test.ts`, `test/tools-core-ownership.test.ts`, `test/tools-core-result.test.ts` | 48 | 0 | 0 |
| 14 | `test/tools-core-review.test.ts`, `test/tools-core-runtime.test.ts`, `test/tools-core-send.test.ts`, `test/tools-core-session.test.ts` | 50 | 0 | 0 |
| 15 | `test/tools-interaction-answer.test.ts`, `test/tools-interaction-inbox.test.ts`, `test/tools-shape.test.ts`, `test/watch.test.ts` | 53 | 0 | 0 |
| 16 | `test/workspaces-collect.test.ts`, `test/workspaces-copyout.test.ts`, `test/workspaces-exec.test.ts`, `test/workspaces-units.test.ts` | 55 | 1 | 0 |
| 17 | `test/workspaces.test.ts` | 11 | 0 | 0 |

The 24 skipped front tests require `OCD_LIVE_EGRESS=1` (`test/egress-live.test.ts`). That flag was not set in this suite run. The remaining skip is the copy-out symlink test, which needs Windows symlink privilege. No fresh live-front result is implied.

Each batch used this command shape, with the files above inserted after `--timeout 30000`:

```text
"<work-queue>" run --lane light -- "C:/Windows/System32/cmd.exe" //d //c "cd /d X:\opencode---session-isolation\alterspective\delegate-mcp && bun test --timeout 30000 <batch files>"
```

PowerShell invoked this through the native Git Bash executable with `--noprofile --norc`; the queue runner was the first command inside Bash. No tests bypassed the queue.

## Fork and type checks

| Check | Observed result |
| --- | --- |
| `packages/server/test/auth.test.ts` | 5 pass, 0 fail |
| `packages/opencode/test/server/auth.test.ts` + `httpapi-authorization.test.ts` | 16 pass, 0 fail |
| `packages/opencode/test/server/httpapi-listen.test.ts` + `httpapi-instance-route-auth.test.ts` | 10 pass, 6 native-PTY Windows skips, 0 fail; includes real trusted plugin SDK and second-process token rejection |
| `packages/opencode/test/config/config.test.ts` + `test/provider/provider.test.ts` | 214 pass, 0 fail in the first full file run |
| Full `packages/opencode/test/provider/provider.test.ts` rerun after correcting the missing Flag import and strengthening the denial assertion | 104 pass, 249 assertions, 0 fail |
| `bun typecheck` from `packages/core`, `packages/server`, `packages/opencode` (queued heavy) | All passed |
| `bun x tsc --noEmit -p .` from `alterspective/delegate-mcp` (queued light) | Passed, including proof scripts |
| Lint of 13 changed fork files (queued light) | 0 errors, 36 warnings. Separate auth/flag/listener run had only six warnings on unchanged listener-test lines |
| Full `packages/core` suite, queued heavy PID `48456` | 1,092 pass, 7 skip, 0 fail; 2,993 assertions across 144 files; 606.63 seconds |
| Full repository `bun run lint`, queued light PID `81832` | Exit 0; 3,529 files, 5,460 warnings, 0 errors |

The first OpenCode typecheck found a missing `Flag` import and an Effect error-type mismatch in `serve`. Both were fixed before the successful rerun. The provider test now checks `External provider modules are disabled`, not merely any failure and an absent marker.

The full OpenCode package suite is queued and has no result yet. Live memory, shell/API and compiled-container canary proofs are recorded separately in [the live receipt](session-api-isolation-live.md).
