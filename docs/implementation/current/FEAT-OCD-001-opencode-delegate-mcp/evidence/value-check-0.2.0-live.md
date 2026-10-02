# Bridge 0.2.0: live value check (#71, #72, #73)

Date: 2026-10-03 (UTC 2026-10-02 23:20). Bridge built from `dev` at `20fcf451d5` (PR #77). Run with `alterspective/delegate-mcp/spike/value-check-live.ts`. The script starts the real bridge as an MCP server under its own name (`value-check`), with `OCD_KEYSTONE_HOST_AUTH=1`, against the real box and Synapse. It changes no client configuration. It uses a scratch repository under the allowed root. Every tool result was checked against a token pattern before it was printed.

## Result

| Item | Check | Result |
|---|---|---|
| #71 | Every model the box offers is `synapse/<id>` | **Pass.** `synapse/auto` plus the 8 models Synapse lists: `anthropic/claude-opus-5`, `claude-opus-5`, `google/gemini-3.1-flash-image`, `google/gemini-3.1-pro-preview`, `openai/gpt-6-astra`, `ornith-1.0-35b`, `qwen/qwen3.8-flash`, `qwen3.8-27b-dflash2` |
| #71 | `synapse/auto` is offered | **Pass** |
| #71 | A non-Synapse model is refused | **Pass.** `oc_start_session {model: "opencode/big-pickle"}` gave `invalid_input` |
| #72 | A task's work comes back as a branch | **Pass.** Task A (create a file, commit) gave `delegate/s-28396c4d69` |
| #72 | That branch merges into the repo | **Pass.** `git merge` exit 0 |
| #72 | Closing removes everything | **Pass.** `oc_close_session {deleteBranch: true}`: session deleted, copy removed, record removed, branch deleted |
| #72 | A session with no work closes | **Pass.** Task B (reply only): session deleted, copy removed, record removed |
| #72 | Nothing is left behind | **Pass, checked by hand** (see below). The box held 41 sessions before and after the run. Neither closed session id appears after closing, and no session is this bridge's |
| #72 | The sweep answers | **Pass.** `oc_cleanup` dry run: 0 examined, 0 to close. It counted 31 records of other bridges, which it never touches |
| #73 | `oc_report` counts the tasks | **Pass.** 6 tasks today for this bridge (all runs below): completed 5, unknown 1 (not sent), success rate 1.0, median 15 s, p90 100 s; collected 1, closed discarded 3, closed clean 2 |
| #73 | `oc_report` carries its notes | **Pass.** "synapse/auto hides which model Synapse routed each task to"; "Token counts are a lower bound" |

### The one script failure, checked by hand

The script's own "nothing left" check failed. It searched the session list for the text `value-check`, and the list's header always names this bridge's supervisor. That was a bug in the check, not in the bridge. By hand, in the list taken after closing:

- Neither closed session id (`ses_f01134ab…`, `ses_f01130614…`) appears.
- No row is marked `mine: true`.
- The box count is 41 before and 41 after.

The script now checks the closed ids and `mine` rows instead. It was not re-run after this fix.

### #74, OpenCode outside the box (the owner's own config)

`opencode models` from this checkout (`packages/opencode`, `bun run src/index.ts models`) lists 9 models, all from the `synapse` provider: `synapse/auto` and the same 8 as above. No other provider appears.

This shows the owner's config offers only Synapse. It does **not** prove the plugin loaded the list live: the owner's config already names those 8 models, and no `synapse-models.json` cache was found in OpenCode's state folder. The likely reason is that the stored Synapse sign-in had expired. By design (#74), startup then uses the configured list and never renews a sign-in. The cache is written after the next chat renews the token. **Not verified live.**

## How the run went

The script's token guard stopped it four times on harmless text, before it printed anything. Each time it was widened for that one shape:

1. The session web link (the box folder in base64url).
2. Event cursors (a random epoch id).
3. A session id followed by a full stop.
4. OpenCode message ids (`msg_…`).

Each stopped run left at most one session open. The next run closed it first (`abort` and `discardWork`, this bridge's sessions only). That is why `oc_report` shows 3 tasks closed as discarded and 1 not sent.

## Not covered

- Which model Synapse picked behind `synapse/auto` (follow-up #76).
- `oc_cleanup` with a real stale session (no session of this bridge was older than 14 days). The dry run's own logic is covered by the unit tests.
- The fork plugin's live fetch (#74): see above. It is covered by its unit tests.
- Older records from other bridges (31) are left as they are, by design.
