# FEAT-OCD-001 — Issues, gaps and deviations

| ID | Type | Description | Status |
|---|---|---|---|
| G-1 | Gap | Fork has no `VISION.md` (`DOC-PV-01`). | Open — recommend a separate small issue |
| G-2 | Gap | Fork has no root `CHANGELOG.md` (`VER-LOG-01`). Package-level changelog planned. | Open |
| G-3 | Gap | No primary GitHub Project for the fork; #41 is issue-only. | Owner decision |
| G-4 | Gap | Fork missing from `repository-tracker-registry.yaml`. | Open — separate change in Alterspective-Intelligence |
| G-5 | Gap | `KB-AI-016` has no `keystone-dynamic` row; its `keystone` row still shows `/api/mcp` with a shared key. | Open — KB follow-up |
| D-1 | Deviation | Logs to stderr + file, not stdout (`OBS-SNK-01`): stdout carries the MCP protocol. | Proposed |
| D-2 | Deviation (A-U only) | A-U would store the server password in a lock file (`ASR-04`). A-S keeps it in bridge memory + container env only. | Resolved by A-S |
| D-3 | Decision | `ERR-COPY-*` / `ERR-PRES-*` apply to CLI text only; tool results go to AI clients and use stable codes + short messages. | Proposed |
| X-1 | Exclusion needed | `BFA-003`: stdio-only transport. Needs owner approval recorded in `AGENTS.md` (category: local developer tool; condition: no remote access; approver: owner). | **Approved by owner 2026-10-01** — recorded in `AGENTS.md` fork notes |
| U-1 | Upstream bug | anomalyco/opencode#52259: inline `OPENCODE_CONFIG_CONTENT` agents/permissions ignored in v2. Design avoids inline config. | Watch |
| U-2 | Upstream bug | anomalyco/opencode#26635: `prompt_async` 204 without a run. Design has a 10 s watchdog. | Watch |
| D-A | Owner decision | Sandbox (A-S) vs same user (A-U). | **Decided 2026-10-01: A-S (Docker box)** |
| Q2 | Owner decision | Egress hosts beyond Keystone + model hosts. | **Decided: + npm + PyPI.** Model hosts default to Synapse (`synapse2-api.alterspective.com.au`) only; other providers opt-in. |
| Q3 | Owner decision | Fork patch in `packages/opencode/src/mcp/`. | **Decided: allowed** (≤150 LOC, env-gated, tested) |
| R-1 | Review | Adversarial round 1 findings C1, C2, H1–H4, M1–M6, L1–L6 dispositioned in `evidence/adversarial-review.md`; round 2 owed. | Open |
| B-1 | Bug | Fork-built box: first model call fails `System message must be at the beginning.` Root cause: the Synapse plugin adds a 2nd system block; the fold into one only ran in the auth-fetch wrapper, which is skipped when the key comes from config/env (`provider.ts:1614`). | Fixed in `plugin/synapse.ts` (wire test red→green); live re-check pending box rebuild |
| B-2 | Bug (design gap) | Box did not set `OPENCODE_DISABLE_PROJECT_CONFIG`, so a delegated repo's `.opencode/` plugins/tools loaded inside the box's OpenCode server (review W2C, wider context). Setting it also drops the repo's AGENTS.md/CLAUDE.md, which Wave 3 must re-inject per session (M4). | Fixed `f180a77a4d` (flags + read-only `~/.opencode`); Wave 3 must re-inject AGENTS.md/CLAUDE.md per session |
