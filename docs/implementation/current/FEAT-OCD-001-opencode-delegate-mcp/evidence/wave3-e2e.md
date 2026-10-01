# FEAT-OCD-001 — Wave 3 live evidence (MOD-04 tools + hub)

Date: 2026-10-01. Box image `opencode-delegate-box:1.18.31-f08f85bb2206` (fork built from `d7644f7`), model `synapse/auto`.

## Run 1 — full tool flow over MCP stdio (`spike/e2e-w3.ts`)

A real MCP client started the bridge over stdio (`bun src/cli.ts mcp`) and called its tools. Bridge build: `0.1.0-dev+341ca101ba.dirty`. That is the F1 + F2 fix round before commit `6bf4046d75`, which adds only the shared session-id pattern and test id renames on top.

| Check | Result |
|---|---|
| Tools listed | 17: `oc_doctor`, `oc_login`, `oc_list_models`, `oc_start_session`, `oc_send`, `oc_status`, `oc_wait`, `oc_events`, `oc_result`, `oc_collect`, `oc_abort`, `oc_list_sessions`, `oc_server_restart`, `oc_pending`, `oc_answer`, `oc_post`, `oc_inbox` |
| `oc_doctor` | `Verified`: box healthy, image matches, policy ok, `ks-delegate` connected, guard ok |
| Start → send → wait → result | Session made `hello.txt` and one commit; `oc_result` reply `DONE` under `untrusted`, `boxReportedCommits: 1` |
| Second session, same repo, while busy | Refused `directory_busy` |
| `oc_collect` | Branch `delegate/s-8ad36fb3d1` fetched into the owner's repo; file content `hi from w3`; host `HEAD` still `main`; `hostExecutableChanges.count: 0` |
| Repo instructions reach the model (B-2) | Asked for the codeword from `AGENTS.md` with no tools: answer `PINEAPPLE` |
| Forged ownership (W3C-01) | A session made through the box API with this bridge's `metadata.supervisor` and session key: not in the default list; in `all: true` as `mine=false`; `oc_send` and `oc_status` → `not_found` |
| Two repos in parallel (R6) | Two sessions in two repos both went idle in 7 s; each branch fetched with its own file; host `HEAD` unchanged |
| Shutdown | Shutdown logged; lease released; box kept for its other holder |

Exit code 0.

## Run 2 — interaction tools against the running box

Scratch script (not in the repo) with a real MCP client over the interaction tools and the inbox poller. Ran before the F1/F2 fix round.

| Check | Result |
|---|---|
| Permission ask | Session asked `bash: git push origin HEAD`; `oc_wait` woke on `permission:needs_input` |
| `oc_pending` | One request, text under `untrusted` |
| `oc_answer` `always` | Refused `policy_violation` |
| `oc_answer` forged request id | Refused `not_found` |
| `oc_answer` `reject` | Accepted; session went `idle` |
| `oc_post` → poller → hub | Hub emitted an `inbox` event for the new message |
| `oc_inbox` | Two messages, with a cursor |
| `oc_post` `wake: true` | Woke the session; it went `idle` again |
| `oc_post` wake to a session not ours | Refused `not_found` |
| Clean-up | Session deleted, `/sessions/iy-56742724` removed |

## Run 3 — full flow through the front proxy (`spike/e2e-w3.ts`, commit `78dc875a49`)

Box replaced with `oc_server_restart {confirm: true, force: true}` over MCP; image `opencode-delegate-box:1.18.31-3c5f47265441`, built from `78dc875`. `oc_doctor` after warm-up: `verified: true`, health `healthy`, `egress.ok: true` (`control: tls-front`, `connectProxy: false`).

Same checks as Run 1, all PASS, exit 0: `directory_busy` on a second session; `hello.txt` collected; `PINEAPPLE`; forged session refused (`not_found`); two repos in parallel (16 s); host `HEAD` unchanged.

## Run 4 — a session calls a Keystone MCP tool through `front`

Scratch script over MCP stdio: a session was asked to call `ks-delegate`'s `get-my-identity` and reply with the email domain only. Reply (untrusted): `TOOL_OK alterspective.com.au`. So the agent reached Keystone MCP as the signed-in user, through `front`.

`front` log for Runs 3–4 (method and status per host; paths are not logged): `identity` POST 200 / 202 / 404, `synapse2-api` POST 200. No other SNI or `Host` appeared. The `identity` POST 404s (5–6 per run) did not break any call; they look like MCP session re-initialisation after the restart, but that is **not verified**.

## Secret scan (T4.6)

The live values of the box server password (32 chars) and `SYNAPSE_API_KEY` (49 chars) were read from `docker inspect opencode-delegate` into shell variables, never printed, and searched for with `grep -F` in: the bridge logs (`~/.local/share/opencode-delegate/logs/`), the Run 1 bridge stderr log, and the Run 1 + Run 2 outputs. **0 hits** (repeated after Run 3 over the bridge logs, the Run 3 stderr log and output, and the `front` container log: 0 hits). A pattern scan (JWTs, `gpaas_`/`gpapp_`/`sk-` keys, `Bearer` values, token/password JSON fields) over the same files also found 0.

Inside the box, the env holds only the secrets the design puts there: `OPENCODE_SERVER_PASSWORD` and `SYNAPSE_API_KEY` (shared key, follow-up #48). Keystone OAuth tokens live in the box data volume by design.

## Not verified

- T3.5 channel push inside a real Claude Code session started with `--channels`. Unit tests cover the notice text and coalescing only.
- F6 Keystone audit row for the delegated user: `list-audit-log` returned HTTP 500 (correlation `275b3d93-390e-4b39-b023-bd8e2bfe6a13`).
- A run of Run 2 against commit `6bf4046d75` itself. The unit suite covers the same paths at that commit (633 pass / 6 skip / 0 fail).
