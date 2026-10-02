# Sandbox worker (spike)

Runs this OpenCode fork headless in a container for one coding task, driven from outside. It is
Phase 1 of CAS FEAT-CAS-012 ("delegate coding to OpenCode sandboxes", CAS ADR-037). Tracked as
fork issue #47.

This folder is separate from `alterspective/delegate-mcp/` (#41, the local delegate bridge). The
two do not share files, image names, container names or ports.

## Parts

| Path | What it is |
|---|---|
| `Dockerfile` | Builds the fork into a single Linux binary. Adds git, gh and ripgrep. Runs as non-root user `agent` (uid 10001). |
| `Dockerfile.dockerignore` | The build context filter for this Dockerfile. The root `.dockerignore` is left alone. |
| `supervisor/main.ts` | Container entry point. Reads the manifest, writes the managed OpenCode config, clones the repository from a git bundle into `/work/repo`, and starts `opencode serve`. |
| `plugins/env-scrub.ts` | Blanks the server password and model key in every shell the agent runs. |
| `driver/run-task.ts` | Stands in for CAS. Runs one task end to end and writes `runs/<taskId>/result.json` and `change.patch`. |

## Build and run

```sh
docker build -f alterspective/sandbox-worker/Dockerfile -t opencodealt-sandbox-worker:spike .
SBXW_MODEL_KEY=<named spike key> bun alterspective/sandbox-worker/driver/run-task.ts \
  --repo /path/to/test/repo --task "Add a unit test for parseDate"
```

Driver flags:

| Flag | Default | Meaning |
|---|---|---|
| `--model` | `auto` | Model id sent to the model route |
| `--base-url` | Synapse v2 `/v1` | OpenAI-compatible base URL |
| `--timeout-min` | `30` | Aborts the session after this long |
| `--keep` | off | Leaves the container running for inspection |

Containers are named `sbxw-<id>`, labelled `alterspective.sandbox-worker=spike`, and published on
`127.0.0.1:47200-47299` only.

## Manifest (environment variable `SBXW_MANIFEST`)

```json
{
  "taskId": "sbxw-…",
  "model": { "baseURL": "https://…/v1", "id": "auto", "headers": { "x-task-type": "code" } },
  "repo": { "bundle": "/run/sbxw/input/repo.bundle", "ref": "optional" },
  "permission": { "*": "allow", "external_directory": "deny" },
  "listen": { "hostname": "127.0.0.1", "port": 4096 }
}
```

## What protects what, honestly

- **The spike is not the security design.** In ADR-037 the sandbox holds no keys, and every
  effect that leaves it goes through the Sandbox Gateway (Phase 2). In this spike the container
  does hold a model key, and its network is open. Use test repositories and a named, revocable
  spike key only.
- **In-box permissions are `allow`.** Anything that still asks is refused by the driver, which
  never replies `always`. Questions are refused, because there is no human in the spike loop.
- **The env scrub is hygiene, not a boundary.** The agent's shell runs as the same user as the
  server, so it can still read the server's environment through `/proc`.
- **The repository config cannot steer the agent.** `OPENCODE_DISABLE_PROJECT_CONFIG=1` stops the
  repository's own `opencode.json` and `.opencode/` from loading. The only config is the one the
  supervisor writes.
- **The patch comes from git in the box against the bundled base**, not from the agent's own
  report.

## Open checks (from the ADR-037 plan)

- [x] The compiled binary loads `.ts` plugins from the config dir. The driver's `envScrub` self-check
  runs a shell command through `POST /session/:id/shell` and got `ok` on 2026-10-01: both the server
  password and the model key were blank for the agent's shell.
- [x] Legacy `prompt_async` does **not** feed the durable `/api` events. For a session driven by
  `prompt_async`, `GET /api/session/:id/history` returned `{"data":[],"hasMore":false}`, and
  `GET /api/session/:id/event?after=0` sent nothing in 10 seconds (2026-10-01). Reattaching after a
  CAS restart therefore cannot replay from `/api` on this path. It has to use `/event` plus the
  `/permission`, `/question` and message lists. Caveat: that run's model call failed straight away
  (dummy key), so recheck after a real model turn.
- [x] A real model run (2026-10-01). Task: add `clamp` to `math.js` plus `node:test` tests, on a two-file
  test repository, model `auto` through Synapse prod with a labelled `gpapp_` app credential. The
  patch was checked by re-running the tests in the box (`node --test`: 2 pass, 0 fail), not taken
  from the agent's report.
- [ ] A run on the CAS #962 corpus, compared with the CAS agent loop.

## Findings so far

- **The fork writes retrospectives into the workspace.** The observer plugin writes
  `.system_generated/retrospectives/retro-<session>-<ts>.json` into the project directory
  (`packages/opencode/src/plugin/observer.ts:255-259`). Without a guard those files land in the
  patch. The supervisor adds `.system_generated/` to the clone's `.git/info/exclude`. The same files
  will appear in any user's repository the fork runs in. The image now sets
  `OPENCODE_DISABLE_SESSION_RETROSPECTIVES=1` (#55), which skips the retrospective file and its
  unauthenticated POST. Other observer logs still go to `.system_generated/`, so the exclude stays.
- **First start is fast.** The server listened 1.3 s after the container started, and a plumbing run
  (session, shell probe, prompt, collection) took 10–12 s of wall time.
- **A missing tool costs many turns.** The bun base image's `node` is a shim that cannot run
  `node --test`. On the first real run the agent spent 39 shell calls finding that out. With real
  Node 22 in the image, the same task took 8 turns instead of 42, 33 s instead of 173 s, and 67,572
  input tokens instead of 509,418. The image now carries Node 22 and npm.
- **The provider must be the fork's `synapse` provider.** With a plain OpenAI-compatible provider,
  Synapse's on-prem backend rejected every request ("System message must be at the beginning."),
  because OpenCode sends several system messages. The fork's Synapse plugin merges them
  (`packages/opencode/src/plugin/synapse.ts:353-380`) but only wraps the provider id `synapse`.
  The supervisor now uses that id, `SYNAPSE_BASE_URL`, and `OPENCODE_AUTH_CONTENT` for the key.
- **OpenCode reports cost 0** for model `auto`, because it has no price for it. Spend has to come
  from the gateway's ledger (Phase 2), not from OpenCode.
- **Personal Keystone tokens do not work on Synapse yet.** A `ks_live_` token with `gpaas:inference`
  gets 401 on prod and staging (Alterspective-Engine/Alterspective-Synapse#1365). The spike uses a
  `gpapp_` app credential, which is Synapse's documented pattern for machine callers.
- **Docker publishes only to loopback** (`127.0.0.1:<port>`), and the server rejects requests without
  the password (401).
