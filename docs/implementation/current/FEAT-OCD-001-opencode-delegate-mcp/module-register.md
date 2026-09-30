# FEAT-OCD-001 — Module register

## Capability hub

| Field | Value |
|---|---|
| Name | CAPABILITY-HUB — opencode-delegate |
| Central outcome | Any local AI client can delegate coding to OpenCode sessions that can use only Keystone MCP services, signed in as the owner. |
| Owner | Igor Jericevich (build: Claude Code session on `opencode-mcp-bridge`) |
| Shared contracts | Tool contracts (`technical-design.md` §5), state machine (§6), profile + allowlist (§3), lock file (§4), inbox record (§7), error codes (§8) |
| Integration responsibilities | `alterspective/delegate-mcp/src/index.ts` wiring, `package.json`, version/SHA, watch CLI entry, E2E suite, fork notes in `AGENTS.md`, this pack |
| End-to-end acceptance | F1–F6 in `acceptance-criteria.md` |

## Modules

| Module | Purpose | Inputs → Outputs | Depends on | Planned docs | Owner | Why independent |
|---|---|---|---|---|---|---|
| MOD-01-server-supervisor | Profile build, start/reuse/stop the delegate server, login | user global config, bridge config → running server + lock + profile dir | hub contracts | `modules/MOD-01-server-supervisor/` | build agent 1 | Owns `src/supervisor/**`, `profile/**` (except `profile/tool/**`), `docker/box/**`, `docker/compose.yaml` |
| MOD-02-policy-guard | Allowlist validation + runtime MCP check + permission baseline + folder rule | profile entries, `GET /mcp`, session list → allow/refuse verdicts | MOD-01 profile shape (contract) | `modules/MOD-02-policy-guard/` | build agent 2 | Pure functions + HTTP reads + egress config; owns `src/guard/**`, `docker/egress/**` |
| MOD-03-event-hub | SSE subscription, state machine, cursor buffer, watch CLI, channel push | `/global/event`, status/permission/question reads → normalised events, states | SDK client | `modules/MOD-03-event-hub/` | build agent 1 (W2) | Owns `src/events/**`, `src/cli/watch.ts` |
| MOD-04-tool-surface | MCP tools, schemas, shaping, fencing, error mapping | tool calls → SDK calls via guard/hub/inbox | MOD-01..03, MOD-05 | `modules/MOD-04-tool-surface/` | build agent 1 (W3) | Owns `src/tools/**`; calls other modules only through their interfaces |
| MOD-05-agent-inbox | Inbox store, bridge tools, OpenCode-side tools | posts → inbox records → reads/wakes | lock helper (hub) | `modules/MOD-05-agent-inbox/` | build agent 2 (W2) | Owns `src/inbox/**`, `inbox-sidecar/**`, `profile/tool/**` |

No two modules write the same file in the same wave (`plan.md` §7).
