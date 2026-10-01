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
- [ ] A real model run (needs a named spike key).
- [ ] A run on the CAS #962 corpus, compared with the CAS agent loop.

## Findings so far

- **The fork writes retrospectives into the workspace.** The observer plugin writes
  `.system_generated/retrospectives/retro-<session>-<ts>.json` into the project directory
  (`packages/opencode/src/plugin/observer.ts:255-259`), and there is no off switch. Without a guard
  those files land in the patch. The supervisor adds `.system_generated/` to the clone's
  `.git/info/exclude`. The same files will appear in any user's repository the fork runs in.
- **First start is fast.** The server listened 1.3 s after the container started, and a plumbing run
  (session, shell probe, prompt, collection) took 10–12 s of wall time.
- **Docker publishes only to loopback** (`127.0.0.1:<port>`), and the server rejects requests without
  the password (401).
