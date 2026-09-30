# FEAT-OCD-001 — Acceptance criteria

| ID | Given / When / Then | Evidence required |
|---|---|---|
| F1 | Given two scratch repos, when Claude calls `oc_start_session` + `oc_send` in each with two different models, then both reach `idle` with a result | Transcript + `oc_result` output in `evidence/` |
| F2 | When a session finishes, Claude learns it without calling `oc_status` in a loop (Monitor line from `opencode-delegate watch`, or `oc_wait` return) | Captured Monitor lines |
| F3 | When a session asks permission, `oc_pending` lists it and `oc_answer once` lets it continue; `always` is refused | Test output + runtime capture |
| F4 | When session A calls `message_session` to B, B's inbox and `oc_inbox` show it; loops stop at 3 hops | Test + runtime capture |
| F5 | When any non-Keystone MCP server is present (config or runtime `POST /mcp`), `oc_send` returns `policy_violation` and busy sessions in that folder are aborted | Red→green tests T2.1–T2.3 + runtime |
| F6 | MCP calls from a delegated session appear in Keystone's audit under the owner | Keystone audit read, or "not verified" stated plainly |
| Q1 | ≥90% line coverage on new code; every guard path seen red first | Coverage report; red test logs |
| Q2 | No server password, token, or API key appears in bridge logs, tool results, or agent shell env | Secret-grep test; `env` capture from a session |
| Q3 | `serverInfo.version` shows `x.y.z-dev+<sha>` in a local build | `--version --json` output |
