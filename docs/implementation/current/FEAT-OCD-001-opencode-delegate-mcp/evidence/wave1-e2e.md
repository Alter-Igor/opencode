# FEAT-OCD-001 — Wave 1 live end-to-end (2026-10-01)

Build: box image `opencode-delegate-box:1.18.31-ea3443e` (fork + MCP allowlist patch + Synapse system-message fix), started by the real supervisor (`spike/start-and-login.ts`). `ks-delegate` stayed `connected` across the image change because the data volume is kept (`compose down` without `-v`).

Script: `alterspective/delegate-mcp/spike/e2e-w1.ts` (real supervisor, workspaces, guard; roots pointed at a temp folder).

| Step | Observed |
|---|---|
| Scratch repo on the host, `workspaces.open` | `/sessions/e2e-muokkzgh`, branch `delegate/e2e-muokkzgh` |
| `guard.checkRuntime` for the session folder | `{"ok":true}` |
| Session with `synapse/auto` + standard permission baseline: write `hello.txt`, `git add`, `git commit` | tools `write` completed, `bash` completed, reply `DONE` — **B-1 fix verified live** (no "System message must be at the beginning") |
| `workspaces.collect` | `{"branch":"delegate/e2e-muokkzgh","commits":1,"hostExecutableChanges":[]}` |
| Host `git show delegate/e2e-muokkzgh:hello.txt` | `hi from the box.` |
| Host HEAD | still `main` |

**Bug found by this run and fixed:** `runCommand` put Node's generic "Command failed" text into `stderr` for a plain non-zero exit, so `boxExists` read "folder absent" (`test -e` exit 1) as a box failure and `open()` always failed live. Unit tests used a fake box and missed it. Fix in `src/supervisor/workspaces-exec.ts`; new real-process test `test/workspaces-exec.test.ts` (2 red on the old code, green after).

Suite after the fix: workspace tests 38 pass / 0 fail.
