# FEAT-OCD-001 — Plan (create-plan, sections 1–12)

**Issue:** [Alter-Igor/opencode#41](https://github.com/Alter-Igor/opencode/issues/41) — local OpenCode MCP bridge for delegated sessions (Keystone-only MCP, per-user OAuth)
**Branch / worktree:** `opencode-mcp-bridge` / `C:\GitHub\opencode---opencode-mcp-bridge` (from `origin/dev` @ `b83572c4cc`)
**State:** Planning, revision 2 (after adversarial review round 1) — awaiting owner approval. Nothing is implemented.
**Evidence:** `evidence/research-findings.md` (code, standards, web). Every `file:line` below is relative to the repo root unless shown otherwise.

---

## 1. Understand the request

| Item | Status | Evidence |
|---|---|---|
| Goal restated | PASS | Let Claude Code (and later Codex/Gemini) hand coding work to OpenCode sessions on this PC, choose the model, watch progress, be told when something happens, answer OpenCode's questions, and run several sessions at once — while those sessions can reach **only** Keystone-relayed MCP services, signed in as the person. |
| Problem | PASS | Today delegation means a human copy-pasting between tools. OpenCode's server already has the API (`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:78-105`), but no AI can drive it, and a delegated session would inherit every MCP server in global + project config, including direct endpoints with shared keys (`.opencode/opencode.jsonc:32-43`). |
| Who benefits | PASS | The owner (parallel coding help without babysitting); other AI tools on the machine; the firm (MCP use stays attributed and revocable per person through Keystone — BFA-007). |
| Vision | PASS | No `VISION.md` in the fork (checked). `DOC-PV-01` requires one → recorded as gap G-1 in `issues.md`, not silently skipped. Plan tested against the fork rule in `AGENTS.md:165` ("small, low-churn, upstream merges stay clean"): **Direct** fit — all new code in a fork-owned folder. |
| Explicit requirements | PASS | R1 start sessions in a chosen repo · R2 send a task and pick the model/agent · R3 check status · R4 listen for events (status, completion, needs-input) · R5 agents can message each other · R6 many sessions at once · R7 sessions may use **only** Keystone MCP services (`/mcp/dynamic`, `/mcp/c/<id>`) · R8 per-user OAuth, no shared keys · R9 local only for now. |
| Implicit requirements | PASS | I1 fail closed if the Keystone-only rule cannot be proven · I2 no secrets in logs, tool results, or files the agent can read · I3 two sessions must not silently edit the same folder · I4 the owner can watch sessions in the web UI · I5 survive restarts of the server and the event stream · I6 upstream merges stay clean. |
| Assumptions (≥5) | PASS | See table below. |
| High-risk assumptions | PASS | A2, A4, A6, A8 flagged (A4, A6, A8 contradicted in review → design changed). |
| Clarifying questions | PASS | In `README.md`: D-A (sandbox), Q1 (BFA-003 exclusion), Q2 (egress scope), Q3 (fork patch). |

**Assumptions**

| # | Assumption | What if wrong | Evidence |
|---|---|---|---|
| A1 | OpenCode can sign in to Keystone from `127.0.0.1:19876` | No per-user MCP at all | `~/.local/share/opencode/mcp-auth.json` already holds a token entry for `keystone-admin` (`/mcp/c/keystone-admin-global`); Keystone always allows loopback redirects (`alterspective-keystone/docs/api/connections-and-oauth.md:540-557`). **Verified by observation, not by a fresh sign-in.** |
| A2 ⚠ | We can give the delegate server a config with **no** global/project MCP servers | Leaks direct endpoints (breaks R7) | Host: no flag drops the global layer (`config.ts:260-274`) and other sources remain (well-known, console org, managed dir — review H4). **Revision 2:** run OpenCode in a container where those sources do not exist (T0.1). |
| A3 | Deep-merge cannot remove a server, only disable it | A later layer could re-add | `config.ts:42-44`, `packages/opencode/src/mcp/index.ts:509-517`. Design does not rely on removal. |
| A4 ⚠ | The guard can see every MCP server a session can use | A hidden server bypasses the guard | **Contradicted in review:** `POST /mcp` publishes no event (`mcp/index.ts:641-646`, re-checked) and `GET /mcp` returns names only (`:591-608`, re-checked). **Revision 2:** fork patch adds URL/type to `GET /mcp` and enforces the allowlist inside `MCP.create/add`; the egress proxy is the real boundary. |
| A5 | `prompt_async` + `/global/event` are enough to track state | Missed completions | `handlers/session.ts:311-329`; `status.ts:39-48`; no replay after reconnect → rebuild from `GET /session/status`, `/permission`, `/question`. |
| A6 ⚠ | Only one refresher per Keystone token family | Keystone revokes the family on refresh-token reuse (`alterspective-keystone/docs/api/standard-oidc-code-flow.md:136-147`) | **Contradicted in review:** MCP state is per directory, so one server has N refreshers (`mcp/index.ts:492-529`; no single-flight in `mcp/auth.ts:72-82`). **Revision 2:** single-flight refresh patch + T0.2 with 3 directories. |
| A8 ⚠ | The agent cannot read the owner's secrets | Direct endpoints reachable with shared keys | **Contradicted in review (C1):** agent shells run as the owner (`tool/shell.ts:416-426`); `HKCU\Environment` holds ~20 shared keys (names observed, no values). **Revision 2:** Docker sandbox. |
| A7 | Claude Code backgrounds MCP calls longer than 2 minutes and wakes the model on completion | `oc_wait` blocks the chat | Claude Code MCP docs (`evidence/research-findings.md` §W2). Cap `oc_wait` at 240 s regardless. |

**Goal decomposition**

| Element | Answer |
|---|---|
| Primary objective | A local stdio MCP server (`opencode-delegate`) that drives a Keystone-only `opencode serve`. |
| Secondary | Watch CLI for Claude Code's Monitor tool; optional Claude "channel" push; agent inbox. |
| Exceptional success | Claude runs 3 sessions in 3 repos on 2 models, gets woken on each finish, answers a permission, and one session messages another — all visible live in the web UI, with every MCP call logged in Keystone under the owner. |
| Acceptable success | Start / send / status / wait / result / abort / answer work for 2 parallel sessions; the guard refuses a session when a non-Keystone MCP server appears. |

**Vision alignment:** `VISION.md` missing but required (`DOC-PV-01`) → G-1. Vision test (`DOC-PV-05`): N/A until it exists; fork rule test: Direct.

GATE 1 PASSED: 9 explicit + 6 implicit requirements, 8 assumptions (4 high-risk), vision missing → G-1.

---

## 2. Explore the context

| Item | Status | Evidence |
|---|---|---|
| Directories | PASS | `packages/opencode/src/{server,config,mcp,permission,session,tool,acp}`, `packages/sdk/js/src/v2`, `packages/plugin/src`, `.opencode/`, `docs/implementation/current/` |
| Instruction files | PASS | `C:\GitHub\AGENTS.md`, `AGENTS.md` (fork notes :163-174); no `VISION.md`, no `INDEX.md` at root |
| Standards router | PASS | `Principles/Web/standards/index.md:40,70,186-210,507-522` |
| Standards selected | PASS | Matrix below |
| Cross-repo impact | PASS | **None for build** (fork patch is in this repo). Registration in `C:\GitHub\.mcp.json` is machine config (not a repo) — done by the owner or with explicit approval. KB update (`KB-AI-036`) in `Alterspective-Intelligence` is a separate follow-up issue after merge (own worktree, own PR). |
| Key files | PASS | See `evidence/research-findings.md` §C1–C10 |
| Patterns | PASS | Fork code lives outside upstream-owned paths (`.opencode/`); ACP layer already drives the SDK end-to-end (`packages/opencode/src/cli/cmd/acp.ts:27-30`, `src/acp/event.ts:152-164`, `src/acp/permission.ts:96-101`) — our reference implementation. |
| Integration points | PASS | HTTP API + SSE of `opencode serve`; `@opencode-ai/sdk/v2` client (`packages/sdk/js/src/v2/client.ts:52-80`); plugin `shell.env` + `tool` hooks (`packages/plugin/src/index.ts:222-228,270-273`); Keystone relay. |
| Existing solutions | PASS | Community `alejandro-technology/opencode-mcp`, `aashahin/claude-opencode-delegate`, `putuandy/claude-opencode-mcp` — none enforce an MCP allowlist; one auto-approves everything (§W1). |
| Constraints | PASS | Windows; Bun; stdio stdout is the protocol (logs → stderr/file); Claude Code output cap 25k tokens; OpenCode v2 inline-config bug anomalyco/opencode#52259 (don't use `OPENCODE_CONFIG_CONTENT` for security). |
| External research | PASS | 22 fetches, 20+ sources, §W1–W5 |
| Hosted adversarial review | PASS | Round 1 done: Synapse gateway (`auto` → `google/gemini-3.1-pro-preview`) artifact reviewer + grounded falsifier with repo access (QUA-001-53). `evidence/adversarial-review.md`. Round 2 after owner decision D-A. |

**Deep context**

| Question | Answer |
|---|---|
| Tried before? | `FEAT-CAS-OPENCODE-BRIDGE` went the other way (OpenCode → CAS). No prior OpenCode-as-MCP work in this fork (`@modelcontextprotocol/sdk/server` only in tests: `packages/opencode/test/fixture/mcp-lifecycle-stdio.ts:1-2`). |
| Fixed vs negotiable | Fixed: Keystone-only MCP, per-user OAuth, local-only, no upstream-file edits. Negotiable: tool names, profile location, channels support, inbox storage. |
| Second-order effects | (1) Delegated sessions lose the fork's `.opencode/` plugins (RAG standards injection, CAS bridge) because project config is disabled — by design, since those use direct endpoints. (2) Redirecting `XDG_CONFIG_HOME` would also redirect `gh`/`git` config inside agent shells unless restored via `shell.env`. (3) Sessions appear in the owner's normal web UI/TUI history (shared data dir). |
| What depends on it | Nothing yet. Future: Codex/Gemini configs, KB-AI-036. |
| Shared data changing while viewed? | Yes — sessions change while Claude and the web UI watch. Not a browser surface of ours, so `REALTIME-STANDARDS` N/A; freshness is handled by the event hub (§4). |

**Standards applicability matrix**

| Standard | Applies? | Rule IDs carried forward | Why |
|---|---|---|---|
| BUILD-FOR-AI | YES | BFA-003, BFA-004, BFA-005, BFA-007 | MCP surface; Keystone relay; OAuth 2.1 + PKCE; stdio-only needs a recorded exclusion (Q1). |
| MCP-STANDARDS | YES | MCP-CONSUME-01; production checklist :1232-1275; sensitive-tool confirmation :707; audit :670; limits :642 | We are an MCP server **and** configure an MCP consumer. |
| ARCHITECTURE | YES | ARCH-ASSESS-01 | Evaluated 3 community bridges; adopting `@modelcontextprotocol/sdk` (already used in repo). |
| CODING | YES | CODE-SIMP-01..05; function ≤50 lines, file ≤400 lines | New code. |
| ERROR-HANDLING | YES | ERR-SPLIT-01, ERR-MSG-03, ERR-ENF-01 | Tool errors go to an AI client; ERR-COPY/PRES apply only to the CLI text (decision D-3). |
| SECURITY | YES | Input validation (:517), secrets (:589), fail closed (:832), zero trust (:951); SEC-OAUTH-01..04 N/A (we are not an AS) | Local server with a password; untrusted agent output. |
| SECRETS-MANAGEMENT | YES | ASR-04, SEC-CRED-CLI-01 | Server password lives in memory + a user-only lock file (deviation D-2). |
| TESTING | YES | TST-VAL-01, TST-VAL-07 (non-visual), TST-FAL-01/02; ≥90% on new code | Every security property gets a red test. |
| LOGGING / OBSERVABILITY | YES | Required fields (:80-91), correlation IDs (:269-282), OBS-AI-02, OBS-ID-01/04; **OBS-SNK-01 deviation** (stdio) | stdout carries MCP → logs to stderr + file (D-1). |
| PERFORMANCE | NO | — | Local single-user tool; budgets set in §9 as success criteria, no standard rule binds. |
| REALTIME | NO | — | Scope is browser SignalR UIs (`REALTIME-STANDARDS` scope); we consume SSE server-side. |
| TRACKING-ANALYTICS | NO | — | No end-user analytics; audit is Keystone's (BFA-007) plus our local audit log. |
| APP-VERSIONING | YES | VER-SRC-01/02, VER-BUILD-02, VER-DEV-01, VER-LOG-01 | CLI/MCP tool; `serverInfo.version` + `--version --json`; fork has no root `CHANGELOG.md` (G-2). |
| UX-UI | NO | — | No UI of ours; the web UI is upstream's. |
| API | NO | OBS-ID-01/04 only (as consumer) | We expose no REST API. |
| AI-LLM-INTEGRATION | YES (indirect) | OBS-AI-02 | Bridge makes no LLM calls; `opencode serve` does. We pass `correlationId` into session metadata. Langfuse tracing of the model calls is OpenCode's, out of scope → noted, not claimed. |
| KEYSTONE-DOWNSTREAM | NO | — | KEY-RETURN-* cover browser login return-to; we have no browser login. |
| SUPABASE | NO | — | Not used. |
| CLI-UX | YES | CLI-UX-06, -07, -15, -19, -20 | `opencode-delegate watch` / `doctor` CLI. |
| ETHICS | YES | ETHICS-AGENT-01, -02, -03 | Delegated agent has declared limits, stop-for-approval thresholds, identifies as AI in inbox messages. |
| MULTI-SURFACE | NO | — | Thin adapter over an existing API; one MCP surface + a watch CLI, not "API + MCP + CLI" product (recorded). |
| DOCUMENTATION | YES | DOC-MOD-01..04, DOC-HF-04, DOC-PV-01 | This pack. |
| WORK-TRACKING | YES | WT-PM-01..11 | #41; no Project board (G-3). |

**External research:** 3+ searches, 20+ sources, insights W1–W5 in `evidence/research-findings.md` (existing bridges; MCP Tasks/channels; timeouts and output caps; OpenCode permissions/config; mailbox pattern).

**MCP considerations:** Server: this bridge (stdio). Consumed by delegated sessions: `ks-delegate` → `https://identity.alterspective.com.au/mcp/dynamic` (+ owner-pinned `/mcp/c/<id>`). State: sessions persist in OpenCode's DB; bridge state (cursors, inbox) in `%LOCALAPPDATA%`-style data dir `…/opencode-delegate/`.

GATE 2 PASSED: 40+ files read, 17 standards assessed (11 YES), 20+ research sources.

---

## 3. Options

> **Revision 2.** Round-1 review (`evidence/adversarial-review.md`) showed the agent's shell runs as the owner and can read every user secret (C1, C2). The first-draft same-user design could not enforce R7. Options are re-cut around **where OpenCode runs**. The earlier ACP option is kept in the change log below; it does not fix C1 either.

### Option A-S — Bridge + OpenCode in a Docker sandbox with an egress allowlist *(recommended)*

**Approach.** Same bridge, tools, event hub and inbox as before, but the one shared `opencode serve` runs in a Docker container that has its own data volume, no host secrets, repos mounted from `C:\GitHub`, and a network whose only exit is a proxy allowing `identity.alterspective.com.au` plus approved model hosts.

**How it works.** The bridge builds the image from this checkout (fork + a small MCP allowlist patch), starts `opencode-delegate`, `opencode-delegate-egress` and `opencode-delegate-inbox` containers, and talks to the server on a `127.0.0.1` port with a password kept in memory. OpenCode signs in to Keystone as the owner (tokens live only in the container volume). Even if the agent reads the password or its own tokens, it can only reach Keystone and the model hosts, so all MCP use goes through Keystone, audited under the owner.

| Pros | Benefit | Evidence |
|---|---|---|
| R7 holds against a misbehaving agent, not just a mistaken one | The owner's hard rule is actually enforced | C1/C2 dispositions |
| No host secrets inside (`HKCU` keys, owner tokens, owner config) | Removes the ~20 shared keys from reach | review C1 (names observed) |
| Separate DB and token family by construction | No TUI resume with full MCP (M3); no family race with the owner's TUI | `packages/core/src/global.ts:11` |
| Docker Desktop already runs here | No new platform | `docker version` → 29.8.0 linux |

| Cons | Impact |
|---|---|
| Bind-mounted repos on Windows are slower; toolchains must be in the image | Slower installs/builds inside sessions |
| Three containers to manage | More moving parts than a single process |

| Hidden risk | Why non-obvious |
|---|---|
| OAuth callback listener binds `127.0.0.1` inside the box (`mcp/oauth-callback.ts:105-131`) | Published ports can't reach it → spike T0.3 |
| Egress allowlist blocks npm/pip the agent expects | Looks like random tool failures → Q2 |

Assessment: Effort L (≈1,900 LOC incl. tests, image, compose), Risk M, Reversibility high. Isolation: spikes T0.1–T0.3 first.

### Option A-U — Same bridge, OpenCode as a host process with an isolated profile

**Approach.** The first-draft design, hardened by the review: isolated `XDG_CONFIG_HOME` profile, `OPENCODE_DISABLE_PROJECT_CONFIG`, explicit env allowlist, separate `OPENCODE_DB`, fork allowlist patch, bridge guard.

**How it works.** OpenCode's own MCP client can only load Keystone entries, and the guard verifies URLs before each send. But the agent's shell still runs as the owner.

| Pros | Benefit | Evidence |
|---|---|---|
| Fastest, native Windows speed | No mount overhead | — |
| Full host toolchains | Nothing to install in an image | — |
| Fewer moving parts | One process | — |

| Cons | Impact |
|---|---|
| A misbehaving agent can read `HKCU` keys / owner tokens and call direct endpoints | R7 holds only for OpenCode's MCP client |
| Needs env allowlist + many doctor checks (H4) to be safe even for mistakes | More ways to be wrong |

Hidden risks: managed config / well-known config sources appear later (H4); `OPENCODE_PURE` drops the scrub plugin (M1). Assessment: Effort M, Risk H for R7, Reversibility high.

### Option B — Adopt a community bridge (`alejandro-technology/opencode-mcp`) + config

Fastest to try, but no allowlist, no permission policy, same-user shell (C1) and third-party supply chain (ARCH-ASSESS-01). Effort S, Risk H.

| Pros | Cons | Hidden risks |
|---|---|---|
| Hours to try; proven tool shape; less code to own | No R7 enforcement; can't carry our fixes cleanly | 5-min wait cap; unknown maintenance |

### Devil's advocate (before recommending)

| Option | Strongest argument against |
|---|---|
| A-S | "Docker on Windows makes coding agents slow and brittle: file watching, line endings, Windows-only toolchains. You'll spend more time on the box than on the bridge, and the owner will turn it off." |
| A-U | "It claims 'Keystone-only' while the agent can `reg query HKCU\Environment` and use the shared RAG key directly. That is the exact failure the owner asked us to prevent." |
| B | "It fails R7 on day one." |

| Failure scenario | A-S | A-U | B |
|---|---|---|---|
| Agent curls a direct MCP endpoint with a stolen key | Refused by egress | Succeeds | Succeeds |
| Upstream sync changes config loading | Box has no other config sources; patch test catches | Doctor + patch test | Unprotected |
| Keystone token family race | Single-flight patch; one box | Same patch | Shared with TUI |
| Windows-only repo (e.g. .NET Framework) | Can't build in a Linux box | Works | Works |

Skeptic's quote: *"If the control lives in the same account as the attacker, it's a suggestion."*

**Recommendation: A-S.** It is the only option that enforces R7 against the agent's own shell. Why not A-U: R7 becomes best-effort. Why not B: no enforcement. DA resolution: measure bind-mount speed in T0.1; Windows-only repos are out of scope for delegation in A-S and flagged by `oc_start_session`. **Would change the choice if:** (1) T0.1 shows sessions are unusably slow on mounts → consider A-U under a separate low-privilege Windows account; (2) the owner accepts best-effort R7 for speed → A-U; (3) T0.3 shows Keystone sign-in can't complete from the box → stop and report (kill criterion).

*Change log:* revision 1 recommended the same-user design (now A-U) over wrapping `opencode acp` per session (rejected: N processes, N token refreshers, no web UI, question tool off, same C1 problem).

GATE 3 PASSED: 3 options, DA complete before recommendation, A-S recommended with 3 change-conditions.

---

## 4. Design — see `technical-design.md` (architecture diagram, contracts, state machine, absent states, fail-direction audit, compliance matrix).

GATE 4 PASSED: 5 modules + hub, 10 edge cases, 19 compliance rows (`technical-design.md` §9).

---

## 5. Pre-mortem

**FM-0 — What will this claim that it cannot actually know?**

| Claim the bridge could make | When the data is absent | Designed answer |
|---|---|---|
| "Session finished" | Stream dropped before `session.status idle` | State `unknown (stream_gap)` until a `GET /session/status` read confirms idle; never infer done from silence. |
| "Session is idle" | Idle sessions are **absent** from `GET /session/status` (`status.ts:42-46`) — so is a deleted or wrong-directory session | Absent ⇒ check `GET /session/:id`; if 404 ⇒ `not_found`, if present ⇒ `idle`. |
| "Keystone-only verified" | `GET /mcp` fails or times out | **Refuse** the prompt (`policy_unverified`). Absence of other servers is never assumed. |
| "Task started" | `prompt_async` returned 204 but no `busy` within 10 s (anomalyco/opencode#26635) | `not_started` + advice to retry; not "running". |
| "Signed in to Keystone" | `ks-delegate` status `needs_auth` or tokens expired | Report `needs_auth` with the `oc_login` action; never "connected" from a stored client entry alone (AILES-024). |
| "No messages in inbox" | Inbox file unreadable/locked | `inbox_unavailable`, not empty. |

**Failure modes**

| # | What happened | Root cause | Early warning | Prevention |
|---|---|---|---|---|
| FM-1 | A delegated session called a direct MCP endpoint | Global config leaked through; isolation broke after an upstream sync | Guard log `policy_violation` in tests; `mcp` list contains non-`ks-` names | Container has no other config sources; egress allowlist; fork allowlist patch + its regression test after each upstream merge |
| FM-2 | Owner got logged out of every Keystone tool | Two processes refreshed the same token family | `invalid_grant` in `ks-delegate` status | Own data volume (own token family); single-flight refresh patch; T0.2 with 3 directories and an expired token |
| FM-3 | Two sessions corrupted one repo | Both edited the same folder | Two `busy` sessions with same directory | Bridge refuses a second busy session per directory unless `allowShared:true`; docs recommend a worktree per session |
| FM-4 | An agent approved its own dangerous command | Supervisor model relayed sub-agent text as approval | `oc_answer` reply matches text quoted from the session | `always` disabled; results fenced as untrusted; `oc_answer` logs + requires the request ID from `oc_pending`, never from session text |
| FM-5 | Claude hung for hours on `oc_wait` | No cap; auto-background off in headless mode | Tool call > 240 s | Hard cap 240 s, returns `still_running` + cursor |

**Kill criteria**

| Signal | Action |
|---|---|
| T0.1: sessions in the box can't build/test a normal Node repo in reasonable time, or egress can't be forced through the proxy | Stop; report with measurements; offer A-U under a separate Windows account |
| T0.3: Keystone sign-in can't complete for the box | Stop; raise a Keystone issue; never fall back to a shared key |
| Fork patch exceeds ~150 LOC in `packages/opencode/src/mcp/` | Stop; ask the owner |
| Keystone DCR refuses the new `ks-delegate` client | Stop; raise an alterspective-keystone issue; do not fall back to a shared key |
| Guard cannot detect a runtime-added MCP server (T2.3 cannot go red) | Stop; R7 is not deliverable safely |

GATE 5 PASSED: FM-0 + 5 failure modes, 3 kill criteria.

---

## 6. Modules and tasks — see `module-register.md` (hub + MOD-01..05) and `checklist.md` (tasks with deliverable, verification, LOC, rule IDs).

GATE 6 PASSED: 5 modules + hub, 26 tasks, every task mapped with rule IDs.

---

## 7. Multi-agent execution

| Wave | Build agents (non-overlapping ownership) | Review agents |
|---|---|---|
| W0 spike | 1 (hub) — T0.1 box + egress, T0.2 token race, T0.3 OAuth from the box (serial: everything depends on them) | 1 security reviewer |
| W0.5 | Hub — fork patch T0.4 (allowlist, URL/type, single-flight) | Security + code quality |
| W1 | Agent-1: MOD-01 server-supervisor · Agent-2: MOD-02 policy-guard | Code quality (checklist A/B) + security (C) |
| W2 | Agent-1: MOD-03 event-hub · Agent-2: MOD-05 agent-inbox | Code quality + integration (D) |
| W3 | Agent-1: MOD-04 tool-surface · Hub: `index.ts` wiring, watch CLI, docs | Security + product/ops (E) |

Rules: every wave runs BUILD → REVIEW (≥3 rounds: logic; types/lint with pasted output; edge cases) → FIX → RUNTIME TEST. Circuit breaker at 5 review iterations → escalate. Hosted adversarial pass on the design (done in planning, `evidence/adversarial-review.md`) and again on the final diff before PR.

---

## 8. Risks

| # | Risk | Category | L | I | Early warning | Mitigation | Contingency |
|---|---|---|---|---|---|---|---|
| 1 | Docker bind mounts too slow / toolchains missing in the box | Technical | M | H | T0.1 timings | Measure early; slim image with common toolchains; per-repo opt-in | A-U under a separate Windows account |
| 2 | Keystone relay flaps (`relay_error`) or DCR policy changes | Dependency | M | M | `ks-delegate` status `failed` | Retry 30–90 s (AILES-043); surface status, never fall back to direct | Pause delegation; report |
| 3 | Agent reaches non-Keystone services via shell/`webfetch` | Security | L (A-S) / H (A-U) | H | Proxy deny log | Egress allowlist (A-S); Q2 decides extra hosts | Tighten allowlist |
| 7 | Fork patch conflicts in upstream syncs | Dependency | M | M | Merge conflict in `mcp/index.ts` | Keep patch tiny + env-gated; regression test | Re-apply from the test |
| 4 | Upstream API drift (`/permission` vs `/session/:id/permissions`, v2 `/api/*`) | Dependency | M | M | SDK regen diff | Use generated SDK from the same checkout; contract test against a real server | Pin fork version |
| 5 | Prompt injection through session output relayed to Claude | Quality/Security | M | H | Instructions inside results | Fence all session text as untrusted; no auto-approve | Owner reviews diffs |
| 6 | Claude Code behaviour (auto-background, channels) differs from docs | Knowledge | M | L | `oc_wait` blocks chat | 240 s cap; channels optional | Watch CLI + Monitor |

Categories covered: Technical, Dependency, Security, Quality, Knowledge (7 risks).

---

## 9. Success criteria

**Functional**

| # | Criterion | Verification |
|---|---|---|
| F1 | Claude starts 2 sessions in 2 scratch repos with 2 different models and both finish | Runtime transcript + `oc_result` output in `evidence/` |
| F2 | Claude is told when each finishes without polling (Monitor line or `oc_wait` return) | Captured Monitor event lines |
| F3 | A permission request is shown by `oc_pending` and answered by `oc_answer` | Test + runtime capture |
| F4 | Session A posts to session B's inbox and B receives it | Runtime capture |
| F5 | A non-Keystone MCP server can't be used: config entry refused by the patch; runtime `POST /mcp` refused; `curl` to a direct MCP host from an agent shell refused by egress | Red→green tests + runtime capture |
| F6 | `ks-delegate` MCP calls appear in Keystone audit under the owner | Keystone audit query (`list-mcp-invocations`) — **owner-visible evidence** |

**Quality:** ≥90% line coverage on new code (TESTING); every guard path has a test that was seen red (TST-FAL-01/02); no secret value in logs/results (grep test); `oc_status` p95 < 200 ms against local server; `serverInfo.version` = `x.y.z-dev+<sha>` locally (VER-DEV-01); adversarial findings dispositioned. Realtime/accessibility/analytics: N/A (reasons in matrix). LLM observability: correlationId in session metadata (OBS-AI-02).

**Definition of done:** docs pack current; #41 updated at each checkpoint; ≥3 review rounds per wave; runtime verified (F1–F5); F6 observed or stated as not verified; PR opened with honest evidence; no merge without owner approval.

---

## 10. Work tracking

| Item | Value |
|---|---|
| Capability hub item | #41 (REST id `5644053843`) |
| Project | **None** — no primary Project exists for this fork (G-3). Owner decision pending (create "opencode Delivery" or stay issue-only). |
| Module issues | Not created yet — created at approval (one per MOD-01..05, linked as sub-issues of #41), so the board never shows unapproved work. |
| Priority | P2 (independent reviewer, provenance comment on #41) |
| Update rules | Checkpoint #41 at: approval, each wave exit, PR open, any blocker (WT-PM-08..10). Never mark Done without F1–F5 evidence. |
| Closeout | PR merged by owner → `aio repo-worktree close --repo C:\GitHub\opencode---opencode-mcp-bridge` → KB-AI-036 follow-up issue in Alterspective-Intelligence. |

---

## 11. Final self-check

All completion-verification boxes addressed: ≥5 assumptions (8) · ≥3 requirements (9+6) · standards with rule IDs · VISION.md absence recorded (G-1) · 3 options · DA before recommendation · FM-0 + 5 failure modes · tasks have deliverable + verification · 7 risks / 5 categories · canonical doc layout · realtime N/A with reason · versioning planned; analytics/accessibility/performance N/A with reasons · LLM observability indirect (OBS-AI-02) · hosted adversarial review round 1 run and dispositioned (`evidence/adversarial-review.md`); **round 2 still owed** after D-A · plain-language outcome + questions in §12.

GATE 11 PASSED (with one open item: adversarial round 2 after the owner's decision).

---

## 12. Summary for approval — see `README.md` (plain-language summary, decisions, next step).
