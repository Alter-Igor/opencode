# Changelog

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
