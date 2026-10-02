# Changelog

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

Tracks [#55](https://github.com/Alter-Igor/opencode/issues/55). Other observer logs and learnings are unchanged; [#50](https://github.com/Alter-Igor/opencode/issues/50) remains open for the wider workspace-output issue.

## 0.1.1 — 2026-10-02

- Keep Synapse sign-ins retryable after a temporary secret-store read error.
- Retain rotated refresh tokens before publishing proxy config, including when storage and state writes fail together.
- Retry failed proxy loads on the next bridge tick.
- Verify a reload through a new nginx worker reply. The proxy loads checked private copies, and doctor reports unknown state when it cannot verify the running config.
- Release the proxy reload lock when its helper dies, so later reloads can retry.

Tracks [#59](https://github.com/Alter-Igor/opencode/issues/59) and [#60](https://github.com/Alter-Igor/opencode/issues/60).

## 0.1.0 — 2026-10-01

Local stdio bridge with sealed Docker sessions, Keystone service limits, host-held Synapse sign-in, checked bundle collection, and optional Claude channel events. Delivered in PRs #52 and #58.
