# FEAT-OCD-001 — AI memory

- Agent shells in OpenCode inherit the serve process env (`packages/opencode/src/tool/shell.ts:416-426`); `shell.env` can override but not remove variables. LSP, formatters, local MCP servers, git and npm spawns do **not** go through `shell.env`.
- `POST /mcp` (`MCP.add`) publishes no event; `GET /mcp` returns names + status only (`packages/opencode/src/mcp/index.ts:591-608,641-646`).
- MCP state is per directory instance; there is no single-flight token refresh (`mcp/auth.ts:72-82`). Keystone revokes a token family on refresh-token reuse.
- Subagents keep only deny + `external_directory` rules from the parent session (`agent/subagent-permissions.ts:20-23`).
- `Global.Path.data` comes from `XDG_DATA_HOME`; config from `XDG_CONFIG_HOME` (`packages/core/src/global.ts:11-13`).
- `OPENCODE_DISABLE_PROJECT_CONFIG` also drops repo `AGENTS.md`/`CLAUDE.md` instructions (`session/instruction.ts:81-88,123-133`).
- `HKCU\Environment` on the owner's PC holds ~20 shared API keys (names only observed). Never read values.
- `opencodealt.bat` runs `packages/opencode/src/index.alterspective.ts` from the **main** checkout, not a worktree.
- Docker Desktop runs here: engine 29.8.0 linux, 12 CPUs.
