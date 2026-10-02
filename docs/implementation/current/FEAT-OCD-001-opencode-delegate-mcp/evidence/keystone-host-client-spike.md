# Keystone host-client spike (#67 step 0)

Date: 2026-10-02. Script: `alterspective/delegate-mcp/spike/keystone-host-client-proof.ts`. Connection: `rag-read`. The owner signed in once in the browser. No token or code was printed or stored.

| Check | Result |
|---|---|
| `/mcp/c/rag-read` without a bearer | Refused: `invalid_token` ("A valid Keystone bearer token is required.") |
| Protected-resource metadata | `resource` = `https://identity.alterspective.com.au/mcp/c/rag-read`; `scopes_supported` = `["mcp:connection"]` |
| Authorization server | Issuer `https://identity.alterspective.com.au`; registration endpoint present; auth methods `client_secret_basic`, `client_secret_post`, `none` |
| Dynamic registration as a new public client, redirect `http://127.0.0.1:19876/mcp/oauth/callback` | Accepted (`token_endpoint_auth_method: none`) |
| Authorize without a scope | Refused: `invalid_scope`. The request must carry `mcp:connection`, which the box's SDK adds from `scopes_supported`. |
| Token exchange | `Bearer`, `expires_in` 3600, refresh token present, scope `mcp:connection` |
| Access-token claims | `iss` = Keystone origin, `aud` = the connection URL (audience-bound, as today), lifetime 3600 s |
| `tools/list` with the host-added bearer | OK, 16 tools |
| Refresh | New access token (3600 s). **The refresh token rotates.** |
| Old refresh token reused after rotation | Refused: `invalid_grant` ("Refresh token is invalid.") |

## What this settles for #67

- The host can be its own Keystone client per connection. No Keystone change is needed.
- Registration and authorize must send `scope=mcp:connection` (take it from `scopes_supported`).
- Rotation is strict: the host must save each new refresh token before it uses the access token. One store per home, under the shared lock, as with Synapse. Two bridges must never refresh the same connection at once.
- `front` must add the bearer: without it Keystone refuses.

## Cleanup

Two spike clients were registered (`dcr-d674…` from a first run refused for `invalid_scope`, and `dcr-0de7…`). Revoke both in Keystone.
