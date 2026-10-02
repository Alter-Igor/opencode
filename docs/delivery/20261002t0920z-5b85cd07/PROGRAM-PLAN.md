# Program plan: #67 move Keystone tokens out of the delegate box

- **Run id:** `20261002t0920z-5b85cd07`
- **planRevision:** 3 (2026-10-02). Rev 3: WS-B integrated; WS-A2 built, in independent review; WS-A1 building. Previously rev 2 (2026-10-02, program director: Claude Code session `cb058128`, sole writer). Rev 2: WS-A split into WS-A1 (token manager) and WS-A2 (`front` injection). They are disjoint surfaces, so they run in parallel; developers briefed for WS-A1, WS-A2 and WS-B.
- **Owner approval:** "OK to do what needed and do it for me" (2026-10-02). Reversible code and docs changes, and ordered merges into the integration branch. **Merging into `dev` and any live-box cutover still need the owner's explicit approval.**

## Outcome

The delegate box never holds a Keystone refresh token or a long-lived access token, and delegated sessions still reach their chosen Keystone connections (`rag-read`, `github`, `seqlogs`).

## Value contract

| Field | Value |
|---|---|
| Beneficiary | The owner, whose Keystone identity the box acts as. Later, any colleague who uses delegate-mcp. |
| Job / pain | Delegating coding to sandboxed agents without handing them durable credentials. Today a prompt-injected box agent can copy `mcp-auth.json` and use the owner's connections from anywhere until the tokens expire. |
| User outcome | Delegated sessions keep working with Keystone connections, with no more sign-in steps than today (one consent per connection). No token can be carried out of the box. |
| Measure / proxy | Number of Keystone tokens readable inside the box (`/data/opencode/mcp-auth.json` entries holding a token). |
| Baseline | Today: one entry per chosen connection, each with access and refresh token (count to be observed at cutover start). |
| Target | 0 tokens in the box. All chosen `ks-*` entries `connected`. |
| Guardrails | `rag-read` search works through the box; a forced refresh keeps every entry connected; the owner's sign-in effort is not higher than today; the box gets 403 on Keystone token and `/.well-known` paths. |
| Observation method | Live check on the owner's box at cutover (WS-C): read `mcp-auth.json`, probe from the box, `oc_doctor` `keystoneAuth`, forced refresh (`…REFRESH_FRACTION=0.05`). |
| Evidence owner / window | Program director runs it, owner confirms; at cutover, then once more after one refresh cycle. |
| Value state | **hypothesised** (step 0 spike proved feasibility; nothing enabled yet). |

## Scope

- **In:** #67 steps 1–5 (host token manager, fork `oauth:false`, `front` injection, cutover, docs).
- **Out:** in-box session isolation (#49, parked as #64); Keystone binding-token exchange (keystone#309, later option); tightening Keystone's DCR scope ceiling (keystone#638, Keystone's own decision).

## Source items

| Item | Source | Workstream | Status |
|---|---|---|---|
| #67 step 0 spike | #67 | — | **done** (`a7f1b3b4d5`, evidence `docs/.../evidence/keystone-host-client-spike.md`) |
| #67 step 1 host token manager | #67 | WS-A1 | active |
| #67 step 3 `front` per-connection injection (flagged) | #67 | WS-A2 | review (`452637d5b1`) |
| #67 step 2 fork accepts `oauth:false` | #67 | WS-B | **integrated** (`c1dc26432b`) |
| #67 step 4 cutover | #67 | WS-C | blocked by WS-A1, WS-A2, WS-B |
| #67 step 5 docs and evidence | #67 | WS-C | blocked by WS-A1, WS-A2, WS-B |

## Workstreams

| ID | Scope (exclusive write) | Depends on | Branch / worktree | Review budget |
|---|---|---|---|---|
| WS-A1 | `alterspective/delegate-mcp/src/keystone-auth/**` (new), `test/keystone-auth*.test.ts`; publishes through an injected `publish(id, bearer)` | — | `ks67-host-tokens`, `X:\opencode---ks67-host-tokens` | 4 cycles |
| WS-A2 | `src/synapse/auth-conf.ts` (variable name as a parameter), `src/guard/egress-identity.ts` (flag `OCD_KEYSTONE_HOST_AUTH`, off by default), `src/supervisor/front-generation.ts`, `docker/front/front-reload.sh`, `docker/front/entrypoint.sh`, their tests | — | `ks67-front-inject`, `X:\opencode---ks67-front-inject` | 4 cycles |
| WS-B | `packages/opencode/src/mcp/allowlist.ts`, `packages/opencode/test/mcp/allowlist*.test.ts` | — | `ks67-oauth-false`, `X:\opencode---ks67-oauth-false` | 4 cycles |
| WS-C | `src/supervisor/profile.ts`, `src/guard/entries.ts`, `src/supervisor/login.ts`, `src/tools/login.ts`, `src/supervisor/auth-store.ts`, `src/supervisor/live.ts`, `src/tools/doctor.ts`, README, `technical-design.md`, `issues.md`, CHANGELOG | WS-A, WS-B integrated | later | 4 cycles |

No overlap between WS-A and WS-B. Parked #64 also touches `profile.ts` and `live.ts` (WS-C). It is not active, and is to be re-based on WS-C if #49 is ever reopened.

**Proportionality (R16):** one feature in one repo. The program director also acts as the manager. One developer agent per workstream (budget: about 120 tool calls, no child agents, report when the budget is reached), and one independent `code-review` agent per review. Synapse model panel for low-risk doc-only diffs.

## Topology and merge order

| Order | Workstream | Branch | Base | Reviewed head | Integration state |
|---:|---|---|---|---|---|
| 0 | spike | `keystone-host-spike` (**integration branch for #67**) | `origin/dev` `4f38093888` | `a7f1b3b4d5` | — |
| 1 | WS-B | `ks67-oauth-false` | `origin/dev` | `d8759d77d3` (remote verified) | integrated `c1dc26432b` |
| 2 | WS-A2 | `ks67-front-inject` | `origin/dev` | — (`452637d5b1` in review) | review |
| 3 | WS-A1 | `ks67-host-tokens` | `origin/dev` | — | active |
| 4 | WS-C | `ks67-cutover` | integration head after 1 and 2 | — | blocked |

Deviation recorded: the integration branch is the existing `keystone-host-spike`, not `program/<run-id>/integration`. Worktrees can only be created through `aio repo-worktree new`, which names the branch after the worktree. One PR from `keystone-host-spike` to `dev` at the end (Gate A, owner approval).

## Risks

| Risk | Impact | Response | Owner |
|---|---|---|---|
| Strict refresh rotation: two bridges refreshing one connection at once lose the token | Owner must sign in again | Reuse the Synapse lock (`src/synapse/lock.ts`); save each new refresh token before using it; test with two bridges | WS-A |
| OpenCode does not reconnect by itself after a token gap with `oauth:false` | Entries show `failed` until reconnect | Bridge calls `POST /mcp/<entry>/connect` after writing a token; doctor reports it | WS-C |
| Cutover touches the owner's live box | Delegation briefly unavailable | Owner approval before cutover; existing tokens revoked by client id afterwards | Director |
| Keystone audit log intermittently returns 500 | Slower diagnosis | Retry with a small page | Director |

## Decisions

| Decision | Owner | Status |
|---|---|---|
| Create `opencode Delivery` Project (#16) as the repo's primary Project | Owner (approved "do what needed") | done 2026-10-02 |
| Live-box cutover window | Owner | due before WS-C live checks |

## Knowledge record (director)

- RAG: lessons search (2026-10-02), `MAI-001-71` PLG-01, `WEBSTA-001-WORK-TRACKING-STANDARDS` (via `OPS-006-00`), `WEBSTA-001-CODING-STANDARDS`, `WEBSTA-001-SECRETS-MANAGEMENT-STANDARDS`.
- Skills: `program-director`, `project-manager` (`OPS-006-00`, inline on this host: not isolated).
- Repo instructions: fork `AGENTS.md`, `C:\GitHub\AGENTS.md`.

## Project receipt

`opencode Delivery` (#16, https://github.com/users/Alter-Igor/projects/16), item `260438990` for #67: Status In Progress, Stage Current, Priority P1 (independent reviewer `ornith-1.0-35b`), Owner Alter-Igor, Target Date 2026-10-02 (review-by, defaulted). Writer: program director.

## Evidence log

- 2026-10-02: spike passed (DCR as a public client, audience-bound 1 h tokens, strict rotation, host-added bearer works; authorize needs `scope=mcp:connection`).
- 2026-10-02: spike clients `dcr-0de7459f-…` and `dcr-d6748237-…` revoked (`revokedCount` 0 each).

## Review ledger

| Workstream | Cycle | Reviewer | Result |
|---|---|---|---|
| WS-B | 1 | independent `code-review` agent | clean. Low #1 (bridge `guard/entries.ts` still refuses `oauth:false`) deferred to WS-C. Low #2 (401 test must check error text) fixed in `d8759d77d3`, confirmation clean. Nit (spy on provider constructor) declined: the control test already proves it. |

## Environment findings

- **Push hook typecheck fails in every worktree on this machine:** `packages/enterprise/src/custom-elements.d.ts` is a git symlink (mode 120000), and `core.symlinks=false` checks it out as a text file (TS1128). Earlier "pre-push passed" results were turbo cache replays. Creating symlinks is not permitted here. With the file absent, the enterprise typecheck passes. Pushes of program branches use `--no-verify`, with explicit `bun typecheck` and test runs as the evidence. Bridge CI on Linux is unaffected.

## Next actions

1. Create worktrees for WS-A and WS-B; brief one developer agent each.
2. Independent `code-review` for each workstream; fix loop within budget.
3. Merge WS-B, then WS-A, into `keystone-host-spike`; then start WS-C.
