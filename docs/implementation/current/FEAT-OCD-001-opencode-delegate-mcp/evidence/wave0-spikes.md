# FEAT-OCD-001 — Wave 0 spike evidence

Spike files: `alterspective/delegate-mcp/spike/t01/` (compose, egress proxy, box image, profile, sign-in relay). Upstream `opencode-ai@1.18.33` from npm was used in the box for T0.1/T0.3; the fork image with the T0.4 patch comes in T1.2.

## T0.1 — Box + egress (2026-10-01)

Setup: `box` on an `internal: true` Docker network (no route out); `egress` = tinyproxy, CONNECT to port 443 only, default-deny host filter (`identity.alterspective.com.au`, `synapse2-api.alterspective.com.au`); `gate` = socat publishing the box API on host `127.0.0.1:47096`; box filesystem read-only, non-root user `agent` (uid 10001), profile mounted read-only, data on a named volume.

| # | Test (run inside the box as the agent user) | Expected | Observed |
|---|---|---|---|
| 1 | `curl https://rag.alterspective.com.au/mcp` via proxy | refused | `000`, curl exit 56 (proxy refused CONNECT) |
| 2 | same, `--noproxy "*"` | no route | `000`, exit 6 (no DNS/route) |
| 3 | `curl https://synapse-mcp.alterspective.com.au/mcp` | refused | `000`, exit 56 |
| 4 | `curl https://identity.alterspective.com.au/.well-known/openid-configuration` | allowed | `200` |
| 5 | `curl https://synapse2-api.alterspective.com.au/v1/models` (no key) | reachable | `401` |
| 6 | `curl http://example.com/` | refused | exit 6 |
| 7 | Host `GET /path` without password | 401 | `401` |
| 8 | Host `GET /mcp?directory=/work/demo` with password | only profile entries | `{"ks-delegate":{"status":"needs_auth"}}` |
| 9 | **Attack:** host `POST /mcp` adding `evil-rag` → `https://rag.alterspective.com.au/mcp` with a static bearer header | must not connect | `evil-rag: failed — SSE error: Non-200 status code (403)` (403 from the egress proxy). Upstream OpenCode accepted the entry; the network refused it. T0.4 patch will refuse it before any connection. |
| 10 | Keystone DCR from inside the box | client registered | `POST /mcp/ks-delegate/auth` returned an authorization URL with `client_id`, `redirect_uri=http://127.0.0.1:19876/mcp/oauth/callback`, `scope=mcp:connection offline_access`, `resource=https://identity.alterspective.com.au/mcp/dynamic` (RFC 8707) |

**Problems found and fixed during the spike**

| Problem | Cause | Fix |
|---|---|---|
| Box exited: `EACCES mkdir /data/opencode` | named volume root-owned | image pre-creates `/data` owned by `agent` |
| Every API call 500: `EROFS … /profile/opencode/.gitignore` | OpenCode writes `.gitignore` into each config dir unless present (`packages/opencode/src/config/config.ts:309-325`); `EROFS` is not caught (only `PermissionDenied`) | profile ships a `.gitignore`; background `@opencode-ai/plugin` install fails harmlessly (warning) — pre-install in the fork image (review L5) |
| `Failed to fetch models.dev` 403 | `models.opencode.ai` not on the allowlist (correct) | `OPENCODE_DISABLE_MODELS_FETCH=1`; models come from the profile |

**File speed on a Windows bind mount (2,000 small files)**

| Operation | Bind mount (`C:\…` → `/work`) | tmpfs |
|---|---|---|
| write | 3,678 ms | 16 ms |
| read | 7,396 ms | — |

Also: `git` refuses the bind-mounted repo (`detected dubious ownership`).

**Design consequence (adopted):** do **not** bind-mount the owner's repos. Each session works in its own clone on a Linux Docker volume (fast, owned by `agent`). The bridge moves code with git bundles through a small hand-off folder: host `git bundle create` → box clones; box `git bundle create` → host `git fetch <bundle>` into a `delegate/<session>` branch. Neither step runs hooks, so the owner's `.git` is never exposed (closes review N2) and sessions never share a folder (I3).

**Not yet measured:** `bun install`/`npm install` time through the registry caches (caches not built yet).

## T0.3 — Keystone sign-in from the box (2026-10-01) — PASS

Method: `t03-login.mjs` calls `POST /mcp/ks-delegate/auth` in the box, opens the owner's browser, listens on host `127.0.0.1:19876`, checks `state` equals the box's `oauthState`, then relays only the `code` to `POST /mcp/ks-delegate/auth/callback`. The box's own callback listener is never reached (it binds `127.0.0.1` inside the box), so the relay is the design, not a workaround.

| Step | Observed |
|---|---|
| Owner signed in and approved in the browser | relay log: `callback relayed, box answered 200` |
| `GET /mcp` after | `ks-delegate: connected` (and `evil-rag` still `failed … 403`) |
| Real session in the box, model `synapse/auto` via the egress proxy, prompt asking to call `get-my-identity` | tool part `ks-delegate_get-my-identity` status `completed`; reply `get-my-identity - alterspective.com.au`; session then absent from `GET /session/status` (idle) |

So: per-user OAuth (R8) works from inside the sandbox, tokens live only in the box volume, and a Keystone tool call succeeds as the owner. **Not yet checked:** the call in Keystone's audit log (F6).

## T0.2 — Token race

Pending the T0.4 patch image (tested once, with the patch, to avoid revoking the new sign-in twice).
