# MOD-02-policy-guard

**Feature:** FEAT-OCD-001 · **Status:** Planning (not started)

Proves the Keystone-only rule: validates profile MCP entries, checks \`GET /mcp\` at runtime, sets permission baselines, and stops two sessions sharing a folder.

- **Owns (write):** \`alterspective/delegate-mcp/src/guard/**\`
- **Depends on:** MOD-01 profile shape (contract only)
- **Tasks:** T2.1–T2.4 (see `../../checklist.md`)
- **Contracts:** `../../technical-design.md`
