# Changelog

## 0.1.4 — 2026-10-02

Host-held Keystone tokens, behind `OCD_KEYSTONE_HOST_AUTH=1`. **Off by default:** with the flag unset nothing changes.

With the flag on:

- The box holds no Keystone token. The bridge signs you in on your PC (`oc_login`, same loopback port), keeps the refresh token in DPAPI and renews the access token in the background.
- The access token goes only into `front`'s read-only include for that connection. `front` sends it on `/mcp/c/<id>` only.
- Each box entry is `oauth: false`. The bridge's profile check requires it; the fork accepts it.
- After a new token is written, the bridge connects the box entry (OpenCode does not reconnect by itself). Every bridge also reconnects signed-in entries on its own box: when it gets a new box, once a minute, and in `oc_doctor`. Overlapping connects of one entry through the same box client are merged into one call.
- `oc_login` uses a running sandbox (even one another bridge started) to connect entries, and never starts a stopped one for that. A connection with a valid host token is only reconnected, with no new consent; `force: true` signs in again.
- A bridge whose flag differs from the one that started the sandbox is refused with an error that names `OCD_KEYSTONE_HOST_AUTH`.
- An access token `front` cannot carry (not a compact JWT, or longer than 3800 characters) is treated as unusable: the rotated refresh token is still saved, nothing is published, and renewal backs off. It is no longer a publish failure retried forever.
- A Keystone reload of `front` no longer writes the Synapse state or logs as `synapse`.
- Keystone metadata is discovered outside the shared lock and cached. A locked refresh that has run 45 s leaves the publish to the next tick, so the lock is never held near its 2-minute wait.
- When a connection leaves the chosen set, its `front` include is emptied at the next sandbox start, so no bearer for it stays on disk.
- The box's sign-in store is emptied on every start, reuse and set change. The client ids removed are recorded for you to revoke in Keystone; tokens are never shown or logged.
- `oc_doctor` adds `keystoneAuth`: each connection's state and expiry, whether `front` loaded its token, front's ids against the chosen ids, and whether the box store is empty. `verified` is false if the box store holds anything.

How to turn it on: README "Host-held Keystone tokens". Tracks [#67](https://github.com/Alter-Igor/opencode/issues/67).

## 0.1.3 — 2026-10-02

- Prune a deleted session's host record only after its clone is also proved absent. Keep records while a clone or link may hold work.
- Use a saved cleanup cursor so old records are checked across list calls and bridge restarts.
- Record which box a session lives in (its compose project) when the session is bound. Prune a record only from that same box. Records from older bridges carry no box name and are kept.
- Never prune a session the bridge still tracks in memory.
- Log each removed record and return its key in `prunedRecords`. `oc_list_sessions` is now marked `destructiveHint: true`.
- Move a record to a private name and check it again before deleting it, so a record rewritten at the last moment is put back.

Only records bound by this version or later, by a bridge with the same fixed name (`OPENCODE_DELEGATE_NAME`) and the same project, are ever pruned. Records from older bridges and from default random `claude-<hex>` names stay on the host.

Tracks [#53](https://github.com/Alter-Igor/opencode/issues/53).

## 0.1.2 — 2026-10-02

- Stop the box from writing session retrospective JSON into task folders or sending the unauthenticated retrospective POST to Keystone. Normal OpenCode runs keep their existing behavior.
- The flag accepts `1` or `true` (any case), like other OpenCode flags. The sandbox-worker image sets it too.

Tracks [#55](https://github.com/Alter-Igor/opencode/issues/55). Diagnostic logs and standalone learning-store operations are unchanged (retrospective-derived learnings are skipped); [#50](https://github.com/Alter-Igor/opencode/issues/50) remains open for the wider workspace-output issue.

## 0.1.1 — 2026-10-02

- Keep Synapse sign-ins retryable after a temporary secret-store read error.
- Retain rotated refresh tokens before publishing proxy config, including when storage and state writes fail together.
- Retry failed proxy loads on the next bridge tick, then back off (doubling, at most 5 minutes). Only failures that can clear by themselves are retried: a stopped proxy or a changed proxy config waits for a new token, a sandbox start or a restart.
- Report a reload with no worker reply as `unverified` and an overlapping reload as `busy`, not `config_invalid`.
- Keep the proxy's last config target when `nginx -t` refuses a new one. Drop that attempt's marker only once the old target is back.
- Bound leftovers from failed or killed reloads: each run removes markers, generations and stage folders older than ten minutes, except the current config and the one workers last loaded (recorded at start and on each acknowledgement).
- Verify a reload through a new nginx worker reply. The proxy loads checked private copies, and doctor reports unknown state when it cannot verify the running config.
- Release the proxy reload lock when its helper dies, so later reloads can retry.

Tracks [#59](https://github.com/Alter-Igor/opencode/issues/59) and [#60](https://github.com/Alter-Igor/opencode/issues/60).

## 0.1.0 — 2026-10-01

Local stdio bridge with sealed Docker sessions, Keystone service limits, host-held Synapse sign-in, checked bundle collection, and optional Claude channel events. Delivered in PRs #52 and #58.
