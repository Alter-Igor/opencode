# FEAT-OCD-001 — Research findings (planning, 2026-09-30)

Gathered by four read-only sub-agents plus direct reads. Code paths are relative to the repo root at `b83572c4cc`.

## Observed in this session (runtime)

| # | Observation | How |
|---|---|---|
| O1 | `opencode web` from source serves the embedded UI on `http://127.0.0.1:4096/` (HTTP 200) | `bun run --cwd packages/opencode src/index.ts web --port 4096`; curl |
| O2 | One server answered for two repos with different project IDs (`?directory=`) | `GET /path`, `GET /project/current` for `C:\GitHub\opencode` and `C:\GitHub\Alterspective-Intelligence` |
| O3 | Paths are reported as `X:\…` (`C:\GitHub` appears mapped to `X:`) | same calls |
| O4 | Browser console: one CSP error for an inline script at `/:20` (page still works) | Playwright |
| O5 | `mcp-auth.json` has a token entry for `keystone-admin` (`/mcp/c/keystone-admin-global`) and a client-only entry for `keystone-dynamic` → OpenCode↔Keystone loopback OAuth has worked before | names/URLs listed, no values read |
| O6 | Agent shells get `process.env` of the serve process plus `shell.env` hook output | `packages/opencode/src/tool/shell.ts:416-425` |

## Code (C1–C10)

| # | Finding | Evidence |
|---|---|---|
| C1 | MCP config schema: local/remote, `oauth` object or `false`, default callback `127.0.0.1:19876/mcp/oauth/callback` | `packages/core/src/v1/config/mcp.ts:6-59`; `packages/opencode/src/mcp/oauth-provider.ts:11-12` |
| C2 | Config layers merge with `mergeDeep`; later wins; no layer can delete a server; `enabled:false` disables | `packages/opencode/src/config/config.ts:42-44,272-548`; `mcp/index.ts:509-517` |
| C3 | `OPENCODE_DISABLE_PROJECT_CONFIG` skips project files + project `.opencode`; no flag skips global | `config.ts:420-424`; `config/paths.ts:23-41`; `packages/core/src/global.ts:13` |
| C4 | Tokens in `<xdgData>/opencode/mcp-auth.json`, keyed by entry name, matched on URL | `packages/opencode/src/mcp/auth.ts:9-31,37,89-95` |
| C5 | Headless auth endpoints: `POST /mcp/:name/auth`, `/auth/callback`, `/auth/authenticate`; statuses `connected/disabled/failed/needs_auth/needs_client_registration` | `server/routes/instance/httpapi/groups/mcp.ts:32-39`; `mcp/index.ts:822-937` |
| C6 | MCP tool name = `sanitize(server)_sanitize(tool)`; deny with pattern `*` hides the tool; session rules override agent rules | `mcp/catalog.ts:117-119`; `permission/index.ts:28-38,204-219` |
| C7 | `POST /session` accepts `permission`, `metadata`, `agent`, `model` | `session/session.ts:260-270` |
| C8 | Events: `session.status`, `permission.asked/replied`, `question.asked`, `session.error`, `todo.updated`, `mcp.tools.changed`; `/global/event` wraps with `directory` | `packages/schema/src/**` (see sub-agent table); `handlers/global.ts:25-46` |
| C9 | Server auth = HTTP Basic, user default `opencode`, only when password set | `server/auth.ts:17-48`; `middleware/authorization.ts:12-132` |
| C10 | SDK v2 client (`createOpencodeClient`) + ACP layer already drive the server end to end | `packages/sdk/js/src/v2/client.ts:52-80`; `cli/cmd/acp.ts:27-30`; `acp/event.ts:152-164`; `acp/permission.ts:96-101` |
| C11 | Project `.opencode/opencode.jsonc` enables direct `alterspective-rag` with a shared key header, direct CAS, stdio `vault-local` | `.opencode/opencode.jsonc:24-78` |
| C12 | Question tool only when client is `app/cli/desktop` or `OPENCODE_ENABLE_QUESTION_TOOL` | `tool/registry.ts:207` |

## Standards (S)

Routed from `Principles/Web/standards/index.md:40,70,186-210,507-522`. Rule IDs used: BFA-003/004/005/007, MCP-CONSUME-01, TST-VAL-01/07, TST-FAL-01/02, CODE-SIMP-01..05, ERR-SPLIT-01, ERR-MSG-03, ERR-ENF-01, OBS-SNK-01, OBS-ID-01/04, OBS-AI-02, VER-SRC-01/02, VER-BUILD-02, VER-DEV-01, VER-LOG-01, ASR-04, SEC-CRED-CLI-01, CLI-UX-06/07/15/19/20, ETHICS-AGENT-01..03, DOC-MOD-01..04, DOC-HF-04, DOC-PV-01, WT-PM-01..11.

Keystone facts: loopback redirects always allowed for native clients (`alterspective-keystone/docs/api/connections-and-oauth.md:540-557`); only scope `mcp:connection` (+ optional `offline_access`); tokens bound to one endpoint (RFC 8707); refresh-token reuse revokes the family (`alterspective-keystone/docs/api/standard-oidc-code-flow.md:136-147`); relay flaps are retry conditions (AILES-043).

## Web (W1–W5)

| # | Finding | Source |
|---|---|---|
| W1 | Community bridges exist (8-tool long-poll bridge; auto-approving delegate; diff-returning bridge); none enforce an MCP allowlist | github.com/alejandro-technology/opencode-mcp · github.com/aashahin/claude-opencode-delegate · github.com/putuandy/claude-opencode-mcp |
| W2 | Claude Code backgrounds MCP calls after 2 min (not in subagents / `-p`); output cap 25k tokens; idle timeout 30 min stdio | code.claude.com/docs/en/mcp |
| W3 | Claude channels (research preview) push `notifications/claude/channel` into a session; needs dev-channels flag for custom servers; stdio only | code.claude.com/docs/en/channels-reference · code.claude.com/docs/en/channels |
| W4 | MCP Tasks (2025-11-25) exists but moved to an extension in 2026-07-28; no evidence Claude Code is a Tasks client → use plain tools | modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks · blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/ |
| W5 | Mailbox pattern (`mcp_agent_mail`): pull-based inbox, acks, loop control; A2A is for cross-host agents | github.com/Dicklesworthstone/mcp_agent_mail |
| W6 | OpenCode permission keys/defaults, config order, MCP OAuth commands; v2 inline-config bug #52259 | opencode.ai/docs/permissions · opencode.ai/docs/config · opencode.ai/docs/mcp-servers · github.com/anomalyco/opencode/issues/52259 |

## Not verified (carried into spikes)

- Whether `XDG_CONFIG_HOME` fully isolates the global layer (T0.1).
- Whether OpenCode refreshes tokens inside its file lock (T0.2).
- Whether the MCP SDK in OpenCode sends the RFC 8707 `resource` parameter to Keystone (T0.2 sign-in will show).
- Claude channels on this Claude Code build (T3.5).
