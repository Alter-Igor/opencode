# FEAT-OCD-001 — Wave 2 live end-to-end (2026-10-01)

Stack: commit `f180a77a4d` (Wave 2 + review fixes). Six containers up: box, gate, egress, npm-cache, pypi-cache, inbox. `ks-delegate` stayed `connected` across the restart (data volume kept).

## Hub + inbox (`spike/e2e-w2.ts`)

| Step | Observed |
|---|---|
| Session created with `metadata.supervisor = supervisor:e2e-claude`, tracked by the hub | `ses_f0b803ca3ffeEa7Y4t0mwjRbgU` |
| Hub events after `markSent` + `prompt_async` | `status:starting` → `status:busy` → `message` → `message` → `status:idle` |
| `hub.wait(until idle)` from a cursor taken before the send | returned `status:idle` (not timed out) |
| Bridge `inbox.read` | `from=session:ses_… verified=false text="hello supervisor, task done"`; `truncated:false` |
| Bridge reply `inbox.post` | `verified=true` from `supervisor:e2e-claude` |
| After DELETE | hub `status:not_found (session deleted)` |

## Workspaces on the Wave 2 stack (`spike/e2e-w1.ts`, hand-off split into `in/` ro + `out/`)

Workspace `/sessions/e2e-muop3n8q`, guard ok, `write` + `bash` completed, collect `{"commits":1,"hostExecutableChanges":[]}`, host file `hi from the box.`, host HEAD `main`.

## Wave 2 exit

Reviews: logic/claims (4 High, fixed) + security/integration (7 Medium, fixed; plus design gap B-2 fixed: repo `.opencode` and `~/.opencode` no longer load in the box). Suite 484 pass / 6 skip / 0 fail; tsc clean; runtime verified live.
