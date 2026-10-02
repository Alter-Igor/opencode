# #49 — Keep the box API password outside agent code

Status: design and implementation reviewed by the root agent. Focused tests, the full bridge and Core suites, package typechecks and repository lint passed. The original-box exploit is reproduced; the fixed-box proof and full OpenCode suite remain pending. See [tests](evidence/session-api-isolation-tests.md) and [live evidence](evidence/session-api-isolation-live.md).
Design date: 2026-10-01. Implementation receipt: 2026-10-02. Scope: `Alter-Igor/opencode#49`, FEAT-OCD-001.
Baseline: `f20d17082e`; dedicated worktree `C:\GitHub\opencode---session-isolation`, branch `session-isolation`.

## Decision to make

Stop a shell in session A reading a reusable server password, answering its own permission request, or calling session B through the running server API. Keep the fork patch small and off unless the bridge enables it. This does not promise isolation between session files or protect against a compromised Docker host.

| Option | What it changes | Assessment |
| --- | --- | --- |
| 1. Password verifier in the box | Keep a random password on the host and in the existing `gate-box` sidecar. Give the box only its SHA-256 digest. Both server auth paths check the digest. Require process-memory protection. | Recommended, subject to the proof below. No new privileged process and no shell-only gap. |
| 2. Separate users for all child code | Run the server and every agent-controlled process as different Linux users. Protect server files as well. | Larger change: shell, PTY, LSP, formatters, subprocess helpers and writable code-load paths must all be covered. A patch to the shell tool alone does not solve #49. |

The existing owner request authorizes a design note, implementation, tests and a PR. It does not authorize a merge. The explicit merge instruction remains required.

## Evidence from the baseline source (`f20d17082e`)

- `alterspective/delegate-mcp/docker/compose.yaml:130` gives the box `OPENCODE_SERVER_PASSWORD`; its health check also expands that password. The box runs as uid 10001 with a read-only root, dropped capabilities and no new privileges.
- `alterspective/delegate-mcp/src/supervisor/compose-env.ts:14` and `src/supervisor/status.ts:50` set and later recover that plaintext password from box inspection. The existing `gate-box` already bridges host loopback to `box:4096` and has its own process namespace.
- `packages/opencode/src/tool/shell.ts:416` builds the legacy shell environment from `process.env`; `:484` starts it. The V2 shell is `packages/core/src/tool/bash.ts:158`, through the generic process service. Other execution paths include `packages/opencode/src/lsp/launch.ts`, `packages/opencode/src/util/process.ts`, `packages/core/src/cross-spawn-spawner.ts`, and `packages/core/src/pty.ts`.
- `packages/opencode/src/server/auth.ts` and `packages/server/src/auth.ts` both compare Basic credentials. The old server mounts routes from the new server too; fixing only one is insufficient. Existing query-string `auth_token` decoding must use the same verifier. PTY tickets remain a separate credential and must not become an unauthenticated bypass.
- `packages/opencode/src/plugin/index.ts:148` gives plugins a client that uses HTTP when `Server.url` is set. `ServerAuth.headers()` currently reads the password environment variable. Merely removing that variable would break internal plugin calls.
- `alterspective/delegate-mcp/profile-tools/inbox-lib.ts:87` is a second internal client: it reads the password env to look up a session's supervisor. It also needs migration. Fixing the plugin client alone breaks inbox tools.
- `packages/opencode/src/server/server.ts:59` already has an in-process web handler. `packages/server/src/routes.ts:47` has an embedded route factory with auth disabled; the old composed route graph does not yet have the equivalent. Any reuse must keep its auth-disabled handler private to in-process callers.
- The bridge disables project config and external skills. `docker/compose.yaml:80` also masks `/home/agent/.opencode` with an empty root-owned mount. These controls remain part of the boundary: a plugin loaded into the server is trusted code, not an isolated shell.
- Two disk-backed config paths bypass that project flag. `packages/opencode/src/config/config.ts:370` loads `wellknown` entries from `/data/opencode/auth.json` and fetches arbitrary `/.well-known/opencode` URLs; `:489` loads active-account config from SQLite through `Account.config()`. The first fetch (`:201`) has no origin allowlist. The account URL is also stored in writable SQLite (`account/repo.ts:60`). Agent code can serve a loopback config containing a plugin path and seed either store. These are source-confirmed paths; live execution remains to be proved.
- `packages/opencode/src/provider/provider.ts:1843` imports non-bundled provider code from `file://` or an npm cache path. The copied owner profile accepts provider npm values. The models catalogue also reads a writable `models.json` cache before considering the disabled-fetch flag (`packages/core/src/models-dev.ts`). A guard only in the profile builder does not cover cache mutation.

## Recommended contract

### Password and verifier

1. Generate at least 32 cryptographically random bytes per new box start. The password is only in bridge memory, the Compose child environment and `gate-box` environment. Never put it in args, a label, a file, health output or logs. The `gate-box` process does not insert auth for unauthenticated callers; it remains a plain TCP forwarder.
2. Add `OPENCODE_SERVER_PASSWORD_SHA256`, a 64-character lowercase hex verifier, only to the box. The existing plaintext variable must be absent there. Hash the raw password bytes, not the Basic header. A copied digest is not an accepted password: every received candidate is hashed before comparison.
3. The new flag alone enables the fork behavior. An empty or malformed present value fails startup closed. If both plain and hashed forms are set, fail startup; do not allow fallback. When the flag is absent, keep existing upstream behavior.
4. Both server auth modules use the same small verifier primitive owned by `packages/server`, with a server-local import in the old package. No Core-to-Server import. Check the exact username and compare fixed-size digest buffers with `timingSafeEqual`. Public Basic and `auth_token` inputs use the same path. No API or Protocol schema changes.
5. Reuse reads the password from `gate-box`, then checks its hash against the box verifier and confirms the expected box/gate image, ports and network settings. A missing gate, legacy plaintext box, wrong digest or altered settings fails closed with `profile_changed` or `policy_unverified`; it never silently recreates a weak box.
6. Health checks cannot recover a password from the verifier. Use a credential-free liveness probe whose expected auth challenge is explicit, plus the host's existing authenticated readiness probe. A `401` liveness result alone does not prove the application is ready.

### Internal client and process memory

The digest protects files and environment, not the server heap: incoming Basic requests necessarily pass through memory. Docker capabilities alone are not a proof that another same-uid process cannot read that memory.

Use one process-local random internal credential in verifier mode. Create it once in a shared auth module in `packages/server`, keep it in a module closure, never in env/files, and make both auth paths recognize it. `ServerAuth.headers()` supplies it only to trusted in-process callers when verifier mode is enabled; explicit caller credentials keep their current behavior. The existing plugin SDK continues to call the existing server over HTTP. This avoids a second route graph and a broad embedded-router refactor. The same memory guard remains mandatory: even without this extra credential, incoming Basic requests pass through the heap.

The profile's inbox tools need that client too. Generate the existing four tool files under `opencode/inbox/` rather than `opencode/tool/`, preserving their relative imports. Add one dependency-free `opencode/plugin/inbox.ts`. Its factory receives `PluginInput.client` and returns the three existing tools in `Hooks.tool`. Wrap only `message_supervisor.execute` to pass a private `readSession(id, directory)` function in the tool context. That function calls the actual legacy SDK `input.client.session.get({ path: { id }, query: { directory }, signal: AbortSignal.timeout(10_000) })`, validates the result and returns session metadata/parent id. `supervisorOf` calls this injected function and fails if it is absent; remove its direct-fetch/password-env code. `message_session` and `read_inbox` do not need the session API. No global mutable module registry or token exposure is needed.

This path is grounded in `packages/plugin/src/index.ts:56` (`PluginInput.client`), `packages/plugin/src/tool.ts:3` (tool context has no client), `packages/opencode/src/config/plugin.ts:23` (plugin discovery), `packages/opencode/src/tool/registry.ts:128` (both tool sources accept legacy JSON args), and `packages/sdk/js/src/gen/sdk.gen.ts:479` (the actual SDK method). Use local structural types or type-only imports; keep runtime imports entirely inside the read-only profile. Test parent-session lookup through the real client and check the profile hash covers the plugin and every helper. No plugin API or generated SDK changes are needed.

### Keep writable files out of the server code loader

Use explicit env-gated restrictions in the managed box; flag-absent behavior stays upstream. Disable both well-known provider-auth remote config and active-account remote config. A new `OPENCODE_DISABLE_REMOTE_CONFIG` flag is preferable to assuming front blocks loopback: front is not on that path. Setting `OPENCODE_AUTH_CONTENT={}` alone closes only the well-known branch and is insufficient.

Before the non-bundled branch in `Provider.getSDK`, refuse file/npm provider imports while the managed-box external-provider restriction is enabled. Bundled providers keep working. This check acts on the final `model.api.npm`, so it also covers writable catalogue-cache changes. It must fail before install/import. Keep the read-only profile plugin/tool files dependency-free and prove their transitive imports stay in the read-only profile or compiled binary.

Live injection proof: in session A create a canary plugin and a local HTTP config server, then seed scratch auth and active-account stores separately. Ask the host to start a fresh session directory for each seed. Neither canary may run, and no remote-config fetch may occur in disabled mode. Plant an external-provider canary through both owner-config fixture and models-cache fixture and verify it is refused before import. A source string check alone is not sufficient.

For this Linux Docker box, the bounded implementation may require Yama `ptrace_scope` >= 1 before the API starts. Fail startup if it is absent, zero, unreadable, or if the live same-uid child probe can open `/proc/<server-pid>/mem` or inspect the parent with `ptrace`/`process_vm_readv`. The process tree matters: agent processes must remain descendants of the trusted server, never its ancestor. The host can check the policy without printing any process environment.

Also set core-dump limits to zero and refuse debugger-start environment or arguments in the managed box profile. Verify no debugger listener is exposed. Record these checks in `oc_doctor`; unknown or failed means not verified. No host sysctl changes, new Linux capabilities, Docker socket mount, root server, or host network are allowed. If Yama is unavailable, an in-process `PR_SET_DUMPABLE=0` guard is a possible follow-up, not an assumed property: it needs its own compiled-binary and child-exec proof.

Official sources supporting this check:

- [Linux Yama](https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html): scope 1 restricts tracing by process ancestry; scope 0 allows ordinary same-user tracing.
- [Linux `/proc/pid/mem`](https://man7.org/linux/man-pages/man5/proc_pid_mem.5.html): access uses a ptrace attach permission check. [Linux `/proc/pid/environ`](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html) describes the initial environment, so deleting a variable after startup is insufficient.
- [Docker 19.03](https://docs.docker.com/engine/release-notes/19.03/) permits ptrace on newer kernels; [Docker 23.0](https://docs.docker.com/engine/release-notes/23.0/) re-enables process_vm_readv/writev. Do not claim the default seccomp profile alone blocks all memory access.
- [Bun debugger](https://bun.com/docs/runtime/debugger): an inspector listener can evaluate code in the process. Verify the actual pinned runtime, not current documentation alone.

### Allowed implementation files

- Fork: `packages/server/src/auth.ts`, one adjacent verifier module if needed, `packages/opencode/src/server/auth.ts`, `packages/opencode/src/cli/cmd/serve.ts`, `packages/opencode/src/config/config.ts`, `packages/opencode/src/provider/provider.ts`, and the relevant env flag declarations in `packages/core/src/flag/flag.ts`. `packages/opencode/src/plugin/index.ts` should need no source change if its existing `ServerAuth.headers()` receives the internal credential. Tests go beside existing auth/server/config/provider tests; keep Protocol, route graphs and generated SDK files unchanged. No Core-to-Server imports.
- Bridge: `src/supervisor/compose-env.ts`, `status.ts`, `lifecycle.ts`, `docker.ts`, `live.ts`, `src/shared/contracts.ts`, `src/tools/doctor.ts`; the smallest new memory-check helper if needed. Use existing injected exec/inspect seams.
- Box: `docker/compose.yaml` and a small baked startup/probe script under `docker/box/` if needed. Add equivalent gate labels/checks so reuse cannot skip verifier checks.
- Profile: `src/supervisor/profile.ts`, `profile-tools/inbox-lib.ts`, and one dependency-free plugin under a new `profile-plugins/` directory if that proves the smallest safe client injection. Keep the profile hash covering all of it.
- Documentation and bridge tests under `alterspective/delegate-mcp/`, plus this design note. No changes to `docker/front/**`, Synapse auth, Keystone services, production settings or the accepted residual risks from PR #58.

## Acceptance tests before implementation is called done

| Layer | Required result |
| --- | --- |
| Verifier unit tests | Correct random password passes; digest-as-password, empty, wrong user, wrong password, malformed digest and conflicting configuration fail. Flag absent preserves legacy behavior. Include inputs with Unicode and colons to pin byte/Basic handling. |
| Server auth integration | Both legacy and V2 protected endpoints reject unauthenticated requests and copied digest. Host password succeeds. Query auth has identical rules. PTY ticket routes cannot skip the ticket's own validation. |
| Internal plugin client | With a live `Server.listen()` and verifier-only env, a trusted plugin can use its actual client against the running session state. A second process cannot recreate that authority from the public verifier. No network-controlled field enables embedded auth. |
| Writable code-load paths | Workspace/home plugin canaries, both remote-config stores and external-provider cache canaries cannot load server code. Actual inbox tools still resolve supervisor and parent sessions. |
| Compose/supervisor | Password absent from box env/health command and present only on the gate side; box digest and gate password match on start/reuse. Missing/mismatched gate fails closed. All existing network, mount and capability restrictions stay intact. |
| Memory/start guard | Same-uid shell cannot read parent memory, ptrace it or use process_vm_readv. Unsupported/unsafe policy prevents managed startup; doctor reports unknown probes as unverified. Core dumps disabled and no inspector exposed. |
| Logs | Tests use sentinel credentials and check stdout, stderr, doctor/error objects and generated artifacts do not include them. Never print actual credentials. |

## Live red and green proof

Use only a scratch Compose project and bridge home created by this task. Hold its lease with an MCP-stdio driver. Do not touch the owner's usual box.

1. Baseline: create scratch sessions A and B. Through A's actual shell, read only whether the password is present and its length; never print its value. Use it in that process to GET B and record only HTTP status and whether B's known id matches. This establishes the old failure.
2. Start the fixed image. Use A's actual shell to inspect its own env and `/proc/1/environ` (presence-only), test the verifier as a password, and try B's GET, prompt/wake, metadata update, permission answer and PTY ticket-issuance endpoints. Every attempt must get `401` before any mutation. Use known-valid scratch IDs and payloads; a `404` or malformed-body error is not proof of auth.
3. From the same shell, attempt parent-memory open/ptrace/process_vm_readv, recording only success/failure and errno. Enumerate listening ports and confirm the expected API port only; do not send debug signals to a shared process.
4. From the host bridge, normal authenticated list/send/wait/answer flows still work. Verify a second bridge can adopt the running box and that the actual plugin client can read session state. Verify doctor positively reports the password/verifier and memory checks.
5. Reuse rejection: use unit/isolated fixture proof for a legacy box or mismatched verifier; no mutation of the default project. Stop the exact scratch Compose project and remove only volumes created for this run after the evidence is saved.

Run tests through the owner's work queue only. Bridge batches are light lane, at most four files each. Run package checks from package directories. The bridge may use its `tsc --noEmit -p .` command; fork packages use `bun typecheck`. The queue executable must be the first command, with `cmd.exe //d //c` and `X:\` paths. Record failures separately from passed checks.

## Scope and limits

This closes API credential theft and unauthenticated control through the running server. The box still shares writable session/data volumes and a uid: an agent can damage files, fill volumes, kill same-user processes, or use the allowed box-wide Keystone services. Those are not new claims of session isolation. Imported server code and read-only profile code stay trusted. Direct database tampering is not made safe by Basic auth.

Rollback means an explicit box restart into the prior image; it restores the known #49 gap and must be called out. Never silently downgrade on failed startup or reuse. Normal OpenCode runs with the new variable absent keep upstream behavior.

## Review and standards receipt

- RAG MCP connected: authenticated `rag_search` succeeded, 2026-10-01. `AIRUN-058` retrieved with `revision_status: clean` and no revision conflicts. Prior AILES search returned no relevant lesson; `Practice/AI/lessons/README.md` was read.
- High-risk review applies because auth crosses the container/server boundary. The contract remains within the existing Schema -> Core/Protocol -> Server direction. No public schema changes, new dependency, new service or extension registry is needed. Existing injection seams remain; a new provider framework would add needless scope.
- `WEBSTA-001-ARCHITECTURE-STANDARDS.md` Core Principles 2–4 and Dependency Inversion: preserve layer direction, injected infrastructure seams, and contract-first behavior. `AIMETH-010`: code inspection is not a live proof. `GIT-WT-01..05`: dedicated worktree; root owns the single issue/checkpoint writer.
- Synapse review: incomplete; not a full panel. Catalogue observed 2026-10-01: `anthropic/claude-opus-5`, `google/gemini-3.1-pro-preview`, `openai/gpt-6-astra`. Gitleaks scanned the original 15,108-byte pack with zero findings. The pack contained internal product architecture only, no client names, token values, private connection ids or live data. Gemini returned a review as the exact requested model; Opus returned empty content after 6,500 tokens, then its one 13,000-token retry reached the 150-second deadline. Astra also reached the 150-second deadline. No other OpenAI-family model was in the catalogue. No three-family completion or second round is claimed. The user also allows a separate-agent independent review; the root agent will use that route rather than silently call this a completed panel.
- Gemini findings: adopt writable-code-path review and PTY-ticket issuance proof (source checked above); adopt explicit memory-only internal-client tests (already in contract). Its portability concern about Yama is valid: document it as a required local-platform capability and fail closed, never change host sysctls. A native dumpability control can replace that prerequisite only after compiled-runtime proof. Rebut automatic destruction of a noncompliant old box: other bridges may own active work, and the existing explicit restart/force flow is the correct replacement gate. A rejected reuse is not a claim that the old box became safe.
- Root design review accepted the bounded implementation on 2026-10-02. Its condition is explicit: the digest alone protects env; writable-code-loader closure and actual memory/canary tests are required before claiming #49 complete. Independent review of the implementation is separate and remains pending.

## Fork implementation receipt (2026-10-02)

`packages/server/src/auth-verifier.ts` owns the digest check and the single process-local internal credential. Both auth modules now use it. The legacy module reuses the shared `Config`, `required` and `authorized` exports; its header wrapper preserves the legacy `Flag` defaults. `serve` resolves the validated auth configuration before starting. The new flags in Core gate both disk-backed remote-config branches and the final non-bundled provider import. No router, plugin API, public schema or generated SDK file changed.

Tests were added before the implementation. The baseline showed missing digest enforcement (four failures), both protected route stacks accepting no credentials (two failures), both remote-config stores still consulted (two failures), and a file-provider canary actually executing. The same checks pass after the patch. All test and formatting commands ran through the owner's work queue.

| Check observed | Result |
| --- | --- |
| `packages/server/test/auth.test.ts` | 5 pass; covers malformed/conflicting config, Unicode/colon password, digest replay, legacy behavior and stable internal credentials without env mutation. |
| `packages/opencode/test/server/auth.test.ts` + `httpapi-authorization.test.ts` | 16 pass; both auth stacks and query auth enforce the verifier. |
| Full `test/config/config.test.ts` + `test/provider/provider.test.ts` | 214 pass; includes both denied config sources and a file-provider canary, plus bundled-provider operation. |
| `test/server/httpapi-listen.test.ts` + `httpapi-instance-route-auth.test.ts` | 10 pass, 6 native-PTY tests skipped on Windows; actual trusted plugin SDK receives HTTP 200 with verifier-only server env. A child importing the same auth module gets HTTP 401 with its own process-local token. Both PTY mint routes return 401 before lookup for absent/copied-digest credentials. |

The first OpenCode typecheck caught a missing `Flag` import and a serve-command Effect error-type mismatch. Both were fixed. The provider denial test now checks the exact error as well as an absent canary marker; an unrelated failure must not count as a working guard. The full provider rerun passed: 104 tests, 249 assertions, no failures. Core, Server and OpenCode package typechecks passed, as did the bridge typecheck including its proof scripts. Lint of 13 touched files returned 0 errors and 36 warnings; the separate auth/flag/listener check returned only six warnings on unchanged listener-test lines.

This is package-test evidence, not the isolated box acceptance proof. The Linux memory probes, file/cache canaries, actual inbox flow, lifecycle adoption, host credential checks and authenticated/unauthenticated live session actions remain required. `alterspective/delegate-mcp/spike/code-loader-proof.ts` now prepares compiled-server canaries in private state directories inside a scratch box. Its baseline mode clears the two new code-loader flags only for those child listeners; its fixed mode inherits and requires the real box flags. It uses fixture credentials and no external model calls. No successful live run is claimed yet.
