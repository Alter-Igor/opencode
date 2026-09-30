# FEAT-OCD-001 — Adversarial design review (QUA-001-53), round 1

Date: 2026-09-30. Reviewed: `plan.md` + `technical-design.md` as first drafted (same-user design, before the sandbox revision).

## Reviewers

| Role | Model / agent | Could see | Output |
|---|---|---|---|
| Artifact reviewer | Synapse gateway `mcp__synapse__chat`, model `auto` → served `google/gemini-3.1-pro-preview` | A written summary of the design only | 5 findings + 3 owner questions |
| Grounded falsifier | Claude sub-agent (general-purpose), file tools | Whole pack, repo at `b83572c4cc`, Keystone docs, standards | 32-row claims ledger + 4 High, 6 Medium, 6 Low, 2 Critical findings |

The falsifier run hit a usage limit once and was resumed from its transcript; its output is complete.

## Claims ledger (summary)

32 claims checked: **24 verified**, **4 partly / overstated**, **3 contradicted**, 1 answered an open spike question. The contradicted and overstated rows changed the design:

| # | Claim in the first draft | Verdict | What the source says | Re-checked by the planner |
|---|---|---|---|---|
| 11 | One shared server ⇒ one Keystone token refresher (A6) | **contradicted** | MCP state is per directory (`packages/opencode/src/mcp/index.ts:492-529`); no single-flight refresh (`mcp/auth.ts:72-82`, `mcp/oauth-provider.ts:96-125`) | yes |
| 22 | `POST /mcp` fires `mcp.tools.changed` (A4) | **contradicted** | `MCP.add` publishes nothing (`mcp/index.ts:641-646`); the event only fires on close / server list change (`:451,:470`) | **yes — confirmed** |
| 28 | Static `headers` disable OAuth | contradicted (rule kept) | Headers are added alongside the OAuth provider (`mcp/index.ts:251-282`) | yes |
| 7 | Managed config is caught by the guard | partly | `%ProgramData%\opencode` overrides the profile (`config/managed.ts:25,32`); a `ks-*` name there would pass | yes |
| 8 | `OPENCODE_DISABLE_CLAUDE_CODE` stops Claude material | overstated | `~/.agents` and walked-up `.claude/.agents` skills still load unless `OPENCODE_DISABLE_EXTERNAL_SKILLS` (`skill/index.ts:186-202`) | yes |
| 16 | Session permission baseline holds | fragile | Subagents keep only deny + `external_directory` rules (`agent/subagent-permissions.ts:20-23`) — **confirmed**; prompt `tools` replaces rules (`session/prompt.ts:1060-1066`) | **yes — confirmed** |
| 23 | `GET /mcp` shows every server a session can use | partly | Names + status only, no URL/type (`mcp/index.ts:591-608`) | **yes — confirmed** |
| 2 | Profile under the data dir | verified + side effect | Data dir comes from `XDG_DATA_HOME` only (`packages/core/src/global.ts:11`) — **confirmed**; DB, `auth.json`, `mcp-auth.json` stay shared | yes |

Full ledger: in the falsifier's report (session transcript); key rows reproduced above.

## Findings and disposition

| ID | Sev | Finding (both reviewers agree where marked ★) | Disposition |
|---|---|---|---|
| C1 ★ | Critical | The agent's shell runs as the owner: it can read `HKCU\Environment` (≈20 shared API keys incl. `ALTERSPECTIVE_RAG_MCP_API_KEY`, `KEYSTONE_AI_ADMIN_API_KEY` — names only observed), `mcp-auth.json` (a `keystone-admin` token), and can run `opencodealt` with full MCP. R7/R8 cannot hold in a same-user design. | **Accepted.** Design revised: delegated server runs in a **Docker sandbox** (Option A-S) with its own data volume, no host secrets, and egress limited to an allowlist. Same-user variant kept only as a clearly-labelled fallback (Option A-U) that does **not** claim R7 against a misbehaving agent. |
| C2 ★ | Critical | Server password reachable (lock file, child-process env: LSP, formatters, git, npm, local MCP) ⇒ `POST /mcp`, `PATCH /global/config`, `PATCH /session`, self-approve `always`. | **Accepted.** In A-S the password never exists on the host filesystem for the agent (it lives only in bridge memory + container env); inside the container the agent could still reach the API, so **egress allowlist is the enforcement**, and a fork patch enforces the MCP allowlist inside `MCP.create/add` (defence in depth). |
| H1 | High | Guard blind: no event on `MCP.add`; `GET /mcp` lacks URL/type. | **Accepted.** Option A′ patch promoted from fallback to plan: env-driven allowlist check in `MCP.create`/`MCP.add` (fail closed) + URL/type in `GET /mcp`. Small, in `packages/opencode/src/mcp/index.ts`, with regression tests. |
| H2 | High | Token-family race across directory instances. | **Accepted.** Fork patch: single-flight refresh per entry name in `oauth-provider.ts`; T0.2 tests 3 directories with an expired token; revocation = kill criterion. |
| H3 | High | Permission baseline lost via subagents / `tools` / `PATCH`. | **Accepted.** Baseline also in profile `permission` config; bridge never sends `tools`; guard re-reads `session.permission` before each send; bash asks relabelled as convenience, not a control. |
| H4 | High | Config sources outside the profile (well-known, console org, managed, inherited `OPENCODE_*`). | **Accepted.** In A-S none exist inside the container by construction; spawn uses an explicit env allowlist; `oc_doctor` checks each; T0.1 red cases for each. |
| G1 | Critical (artifact) | Pattern-based bash asks are bypassable. | **Accepted.** No security claim rests on bash patterns any more. |
| G3 | High (artifact) | `~/.opencode` would block every prompt. | **Kept as designed** (fail closed) + `oc_doctor` names the fix. Moot inside the container. |
| G5 | Medium (artifact) | Inbox file can be tampered with. | **Accepted.** Inbox moves into the bridge-owned host dir **outside** the container mount; container tools reach it only via the bridge; messages always untrusted; limits enforced at read. |
| M1 | Medium | Inherited `OPENCODE_PURE` silently drops the profile plugin. | Env allowlist; `oc_doctor` verifies plugin loaded. |
| M2 | Medium | Profile dir writable by the agent. | A-S: profile mounted read-only; whole-dir hash. |
| M3 | Medium | Shared session DB lets the owner's TUI resume a delegated session with full MCP. | A-S: own data volume/DB by construction; A-U: `OPENCODE_DB=opencode-delegate.db`. |
| M4 | Medium | `OPENCODE_DISABLE_PROJECT_CONFIG` also drops the repo's `AGENTS.md`/`CLAUDE.md`. | Bridge passes absolute instruction paths per session (config `instructions`). |
| M5 | Medium | No-directory requests hit the server cwd. | Always send `directory`; guard per session directory. |
| M6 | Medium | Allowlist let `oauth.clientSecret/redirectUri/callbackPort` through. | Forbidden in the validator. |
| L1–L6 | Low | NTFS ignores `0o600`; `opencodealt.bat` points at main checkout; fixed callback port 19876 clashes; built-in Synapse provider transport; npm install of `@opencode-ai/plugin` on start; password accepted as URL query token. | L1 wording fixed; L2 supervisor resolves its own entry; L3 own callback port for `ks-delegate`; L4 R7 wording excludes model-provider transport; L5 pre-installed in image; L6 never put password in URLs/logs. |

## Owner questions raised by reviewers

1. Is the Docker sandbox acceptable as the default (slower file access on Windows mounts, toolchains must be in the image)? → **Decision D-A in `README.md`.**
2. Should delegated agents have outbound internet beyond Keystone + model hosts (npm install, docs)? → **Q2 in `README.md`.**
3. Is a small fork patch to `packages/opencode/src/mcp/` acceptable (allowlist + single-flight refresh)? → **Q3 in `README.md`.**

## Round 2 (2026-10-01, after owner decisions)

Reviewer: Synapse gateway, `auto` → served `google/gemini-3.1-pro-preview`, artifact-only (revision-2 summary).

| Round-1 item | Verdict | Planner check |
|---|---|---|
| (1) bash patterns | RESOLVED | agreed — no claim rests on them |
| (2) password → `POST /mcp` / self-approve | PARTIAL | agreed: inside the box the agent shares the OpenCode process user; egress + patch are the boundaries |
| (3) other config layers | RESOLVED | — |
| (4) user secrets / tokens | RESOLVED | only `SYNAPSE_API_KEY` enters the box (model transport, not MCP) — noted |
| (5) inbox spoofing | RESOLVED | — |
| (6) no event / no URLs in `GET /mcp` | PARTIAL (`ks-spoof` name) | resolved by the patch: URL checked at add/connect, not the name |
| (7) token family race | RESOLVED | pending T0.4 evidence |
| (8) subagents drop asks | RESOLVED (reviewer) | planner: only partly — asks remain convenience; not a boundary |
| (9) config/env sources | RESOLVED | — |

**New findings and disposition**

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| N1 | High | Agent in the same container can kill/modify OpenCode and drop the patch | Partly valid. Egress still blocks direct hosts, so R7 holds. Harden: image filesystem read-only (`--read-only` + tmpfs), OpenCode code owned by root, server runs as non-root. |
| N2 | High | **Git hook / config poisoning:** `/work` is rw, so the agent can write `.git/hooks`, `.git/config` (`core.fsmonitor`, `core.hooksPath`), `.husky/*`; the owner's next host `git` run executes it | **Accepted.** Mount only the session's repo (ideally a dedicated worktree), not all of `C:\GitHub`; overlay `.git/hooks` and `.git/config` read-only; `oc_result` flags changes to host-executable paths (`.husky/`, `.githooks/`, `package.json` scripts, `.git*`). Residual: any code the agent writes may later run on the host — the owner reviews diffs before running them. |
| N3 | High | Exfiltration by publishing to npm/PyPI | **Accepted.** Replace direct registry egress with read-only pull-through caches on the internal network (publish disabled); the box never reaches the public registries directly. Keeps Q2's intent (installs work). |
| N4 | Medium | 15 s polling window | Resolved by the patch (refused at add time). Poll kept as a second check. |

Round 3 is owed on the final diff before the PR.
