# #49 — Bridge and process-memory guard checks

Date: 2026-10-02. Worktree: `C:\GitHub\opencode---session-isolation`.
Base: `f20d17082ec9da05a7e02ac3cf95571f98cdd913`.

These checks cover the bridge half of #49. They do not replace the live session-shell/API proof against the rebuilt fork. The root agent owns that proof and the final independent diff review.

## Observed tests

All commands used the owner's work queue, light lane, at most four bridge test files per command. Bun reported `1.3.14`.

| Queue child PID | Command after changing to the bridge package | Observed result |
| --- | --- | --- |
| 97384 | `bun test --timeout 30000 test/session-api-isolation.test.ts` | Red before implementation: missing implementation module, 1 failed test |
| 102628 | `bun test --timeout 30000 test/session-api-isolation.test.ts test/supervisor-compose-env.test.ts test/egress-compose.test.ts` | 16 pass, 0 fail |
| 17416 | `bun install` | 99 packages installed; needed before doctor tests could import zod |
| 18392 | `bun test --timeout 30000 test/inbox-tools.test.ts test/doctor-live.test.ts test/supervisor-lifecycle.test.ts test/supervisor-docker.test.ts` | 56 pass, 0 fail |
| 71348 | `bun test --timeout 30000 test/session-api-isolation.test.ts test/supervisor-lifecycle.test.ts test/supervisor-lifecycle-review.test.ts test/supervisor-replace.test.ts` | 37 pass, 0 fail |
| 39140 | `bun test --timeout 30000 test/supervisor-profile.test.ts test/supervisor-identity.test.ts test/doctor-live.test.ts test/supervisor-lifecycle.test.ts` | 70 pass, 0 fail, including refusal before sending host credentials when the memory check fails |
| 85036 | `bun test --timeout 30000 test/tools-core-review.test.ts test/tools-core-result.test.ts test/auth-store.test.ts test/inbox-tools.test.ts` | 50 pass, 0 fail |
| 62600 | `bun x tsc --noEmit -p .` | Exit 0 |

The inbox test uses the real legacy `createOpencodeClient` against a local test API. Parent-session lookup and message delivery pass while `OPENCODE_SERVER_PASSWORD` is absent from the tool process env. Calling the helper without the injected client fails. This proves SDK wiring, not the fork's HTTP auth middleware.

## Live kernel guard

Exact command:

```powershell
bash -c '"<work-queue>" run --lane light -- "C:/Windows/System32/cmd.exe" //d //c "cd /d X:\opencode---session-isolation\alterspective\delegate-mcp && bun spike/memory-guard-proof.ts"'
```

Queue PID `45528`, exit `0`. Four new disposable containers used `opencode-delegate-box:1.18.31-bc1a3343c278`, with network `none`, read-only root, dropped capabilities, no new privileges, and no real credentials. Each was removed by `docker run --rm`.

| Fixture | Probe result |
| --- | --- |
| Safe env, core limit 0 | Scope 1; `/proc/parent/mem`, `ptrace` and `process_vm_readv` all denied; exit 0 |
| Core limit 1 | `coreDisabled:false`; exit 1 |
| `BUN_INSPECT` present | `debuggerDisabled:false`; exit 1 |
| Plaintext password env present, sentinel only | `verifierOnly:false`; exit 1 |

The probe runs as a same-uid child of its target. No memory bytes or env values are returned. The first run found trailing spaces after `bytes` in `/proc/<pid>/limits`; the parser was fixed and all four fixtures rerun.

## Pinned compiled-runtime signal check

The same queue wrapper ran `bun spike/inspector-signal-proof.ts`, queue PID `84196`, exit `0`. It started its own compiled OpenCode child in another disposable network-none container, then sent SIGUSR1 to that exact child. Output:

```json
{"runtime":"compiled Bun 1.3.14 image","before":[4096],"after":[],"outcome":{"code":null,"signal":"SIGUSR1"},"inspectorOpened":false}
```

SIGUSR1 killed that process; no inspector listener appeared. Same-user process killing remains an accepted limit. The script accepts an optional image argument so the root can repeat it against the newly built image. It never signals the owner's box.

## Boundaries and remaining delivery checks

- Managed startup and reuse verify the gate image/command/loopback port, isolated PID namespaces, box digest, absent plaintext, required flags, and live memory checks before sending an authenticated host request.
- `oc_doctor` treats missing/unknown probe fields as unverified. No new production settings, sysctls, Linux capabilities or services were added.
- Full bridge suite, final typecheck/lint after all edits, rebuilt-image entrypoint/health checks, and the session-shell API red/green proof remain with the root agent. No merge or deployment is claimed.
