# FEAT-OCD-001 — Impact analysis

| Area | Impact | Notes |
|---|---|---|
| Upstream-owned code (`packages/**`) | Small, env-gated patch in `packages/opencode/src/mcp/` (Q3) | Everything else lives in `alterspective/delegate-mcp/` (outside the Bun workspaces in `package.json:25-32`). |
| `bun.lock` | None | The package has its own lockfile. |
| Fork notes (`AGENTS.md`) | Small addition | New bullet under "Fork-local (Alterspective) notes"; BFA-003 exclusion only after owner approval. |
| Owner's OpenCode data | None (A-S) | The box has its own data volume: own DB, own `mcp-auth.json`. Delegated sessions are watched through the box's web UI, not the owner's TUI. (A-U would share them — review M3.) |
| Owner's Keystone account | New OAuth client | One new DCR client (`OpenCode`, loopback) and token family for `ks-delegate`. Revocable in Keystone. |
| Owner's TUI `keystone-dynamic` login | None | Different entry name → separate token family (`technical-design.md` §3). |
| Fork's `.opencode/` plugins in delegated sessions | Not loaded | By design: they use direct endpoints (RAG standards injection, CAS bridge). Keystone-relayed RAG (`/mcp/c/rag-global`) can be pinned instead. |
| Machine MCP config (`C:\GitHub\.mcp.json`, Claude user config) | Registration entry | Owner action or explicit approval; not part of the PR. |
| Knowledge base (`KB-AI-036`) | Follow-up | Separate issue + worktree in Alterspective-Intelligence after merge. |
| Containers | +3 while any bridge runs (box, egress proxy, inbox sidecar) | Stopped when the last bridge lease ends. |
| Docker Desktop | Required | `sandbox_unavailable` if not running; no silent fallback. |
