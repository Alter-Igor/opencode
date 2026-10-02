# #49 live session/API proof

Date: 2026-10-02. Worktree: `C:\GitHub\opencode---session-isolation`.
Base: `f20d17082ec9da05a7e02ac3cf95571f98cdd913`.

Each run creates a new Compose project and a fresh bridge home. Its fixture profile
has no Keystone connections or owner credentials. The host generates the test API
password in memory. The proof prints booleans and HTTP status codes, never the
password, its digest, or an API response body. Cleanup removes only that run's
containers and volumes with `docker compose -p <project> down -v`.

## Original box

Command, through the heavy work queue:

```powershell
bash -c '"<work-queue>" run --lane heavy -- "C:/Windows/System32/cmd.exe" //d //c "cd /d X:\opencode---session-isolation\alterspective\delegate-mcp && bun spike/session-isolation-proof.ts baseline"'
```

Queue PID `104528`, exit `0`. Project `ocd-api-proof-4d83dad1`, image
`opencode-delegate-box:1.18.31-bc1a3343c278`, built from the original `f20d17082e`
checkout. The live shell endpoint ran Python in session A and targeted session B.

| Check | Observed result |
| --- | --- |
| Plaintext API password in the shell environment | Present |
| Plaintext API password in `/proc/1/environ` | Present |
| Read session B using that password | HTTP 200; returned session ID matched B |
| A second host bridge adopts the running box | Same authority; authenticated session read HTTP 200 |
| Cleanup | Exit 0 |

The first attempt at this proof had no result record. Inspection showed the shell
API waits for command completion, but its Bash command wrapper does not preserve
the heredoc's newlines. The driver now sends one shell line and decodes its Python
source inside Python. The successful run above observed a completed tool part and
184 bytes of safe result output.

## Fixed box

The fixed image build and live checks are pending. No fixed-box result is claimed
by this receipt yet. The compiled code-loader proof will run both controls against
the new image: one with the two new loader guards cleared in private child servers,
and one with those guards enabled. The real server's settings are never cleared.
