# Keystone host-held tokens: live cutover evidence (#67)

Date: 2026-10-02. Bridge and box built from `dev` at `b8cfd8a574` (PR #69). Run with `alterspective/delegate-mcp/spike/keystone-cutover-live.ts`, which starts the real bridge as an MCP server with `OCD_KEYSTONE_HOST_AUTH=1` and does not change any client configuration. No token text was printed: every tool result was checked against a token pattern before printing. The owner approved one browser consent per connection.

## Baseline (before)

Read-only: a throwaway container running as the box user, with no network and the volume mounted read-only.

- `opencode-delegate_data:/opencode/mcp-auth.json`: 5164 bytes, last written 2026-10-01 10:58 UTC.
- It had 3 entries (`ks-github`, `ks-rag-read`, `ks-seqlogs`), each with an access token and a refresh token.
- The old box clients `dcr-00c32911-…`, `dcr-7a845abb-…` and `dcr-ab639d12-…` were revoked: `revokedCount` 5, 2 and 5, so **12 live refresh tokens were killed**.
- The earlier pruned client `dcr-9f0122e6-…` (`ks-rag-global`) returned `revokedCount` 0, because it was already dead.

## Cutover (after)

| Check | Result |
|---|---|
| `oc_login` per connection, signed in on the host | `ks-rag-read`, `ks-github`, `ks-seqlogs`: signed in on the host, box entry `connected` |
| `oc_doctor` | `verified: true`; `keystoneAuth.ok: true`; front has each token loaded; "the box stores no sign-in (host-held Keystone tokens)" |
| Box token store, read back independently | `mcp-auth.json` is `{}` (2 bytes, written 2026-10-02 12:16:49 UTC) |
| From inside the box, no token sent: MCP `initialize` to `/mcp/c/rag-read` | HTTP 200, `serverInfo` `alterspective-rag` 1.153.0, because front added the bearer |
| From inside the box: `/api/oauth/token`, both `/.well-known/oauth-*`, `/api/oauth/register`, `/api/oauth/authorize` | HTTP 403 each |
| Forced early refresh (`OPENCODE_DELEGATE_KEYSTONE_REFRESH_FRACTION=0.05`) | All three rotated (expiry 13:16 → about 13:20 UTC), stayed `connected`, `verified: true` |

The first `oc_doctor` in the refresh run read `NOT verified` with "Docker health starting". It ran seconds after the box started, before its health check passed. The second reading, with the box healthy, is verified.

## Value

Usable Keystone tokens reachable from the box's storage: 12 live refresh tokens before, **0** after. Delegated sessions keep their Keystone connections, at one consent per connection (no more than before).

## Not covered

- The `rag-read` check is an MCP `initialize` through front, not a full search tool call. OpenCode reports the entry connected with its tools.
- Codex and Gemini clients were not tested.
- On this PC the bridge is not registered in any Claude client. To use it day to day, register it with the flag in its environment (README, "Host-held Keystone tokens").
