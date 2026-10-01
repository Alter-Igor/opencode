# MOD-01-server-supervisor

**Feature:** FEAT-OCD-001 · **Status:** Planning (not started)

Builds the Keystone-only profile and starts, reuses or stops the one delegate \`opencode serve\` per user. Also runs the Keystone sign-in (\`oc_login\`).

- **Owns (write):** \`alterspective/delegate-mcp/src/supervisor/**\`, \`alterspective/delegate-mcp/profile/**\` (except \`profile/tool/**\`)
- **Depends on:** hub contracts
- **Tasks:** T1.1–T1.5 (see `../../checklist.md`)
- **Contracts:** `../../technical-design.md`
