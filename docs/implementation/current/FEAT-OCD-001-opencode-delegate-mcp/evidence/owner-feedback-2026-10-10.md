# Owner feedback 2026-10-10 + live root-cause findings

Source: owner's two-day report (2026-10-08..10). Investigation on 2026-10-10 04:18-06:45Z from this PC (bridge home `~\.local\share\opencode-delegate`, box `opencode-delegate*`, logs `logs\bridge-2026-10-08.log` / `bridge-2026-10-10.log`).

## What the owner reported (verbatim summary)

Works: token savings (#852 built/QA'd/arch-checked on Synapse models, ~10 oc calls vs 200-700k Claude tokens each); real quality (gpt-6-astra built, kimi-k3 QA found 4 missed write paths); safe by design (copied repo, branch-only collect, per-session keystone narrowing).

Bugs:
1. Gate unreachable → `oc_pending`/`oc_answer` fail "failed to list pending permissions"; a session waiting on a permission is stuck. Evidence: `oc_doctor` → `gate.reachable:false` 2026-10-10 04:18Z, session `ses_edbf9219…`.
2. `oc_send` with `syncRef` fails every time: "failed to fetch sync bundle" (2 of 2, 2026-10-08 ~04:58Z/~05:14Z). Had to close+reopen sessions for new commits.
3. Server drop mid-task (`server_down`, "socket connection was closed") 2026-10-08 04:53Z; session recovered and work survived, but `oc_wait` returned with nothing.
4. Sandbox has no node_modules and no pnpm → delegated sessions can't typecheck or run the full suite. Builder claimed "62 tests passed" (partial); owner's full run found 10 failures (#852, commit ab56523).
5. "Synapse requires login" inside the box → builder's built-in self-review never ran (#852 build reply).

Improvements:
1. `synapse/auto` bad default for coding (8 lines in 32 min); gpt-6-astra did the whole job in ~10 min. Default code tasks to a coder model or document model↔task fit.
2. readonly profile asks permission per grep (one round trip each). Auto-allow safe read-only list (grep, rg, cat, head, git diff/log/show) or add a "read-only shell" profile.
3. `oc_wait` should carry a usable requestID so `oc_answer` works even when `oc_pending` is down.
4. `oc_result` truncated a long review before its verdict lines. Always return the final section, or page.
5. `oc_wait` times out ~120s then backgrounds → ~10 wait calls per 20-min build. Longer waits or one idle notification.
6. Remove `dynamic` by default (box carries it; every warning flags it).

## Live root-cause findings (this investigation)

### B1 — two distinct failures merged into "gate unreachable"
- `~\...\keystone.json` (saved set) = `rag-read, github, seqlogs, dynamic`. This opencodealt bridge's ceiling (`OPENCODE_DELEGATE_KEYSTONE_ALLOWED`, unset → default `rag-read, github, seqlogs`) excludes `dynamic`. `statusOf()` (`src/supervisor/status.ts` ← `keystone-policy.ts:71-81` `outside ceiling: dynamic`) reports the whole box `state:"unavailable"`, so `gateReport()` (`src/tools/doctor.ts:215-226`) short-circuits to `reachable:false` — the gate container itself is up and healthy (`docker inspect`: running; admin port 56546 answers; `/v1/approvals?state=pending` → `{"approvals":[]}`). A doctor ceiling mismatch masquerades as a dead gate. `verified:false` also stems here.
- The owner's bridge (`claude-main-109916`, dynamic in its ceiling) saw the OTHER failure: `oc_pending` → `upstream_error` (log 2026-10-10T04:18:21Z ms=1045 and 04:30:02Z ms=4096) from the box's `GET /permission?directory=/sessions/<key>` (fail-closed path: `src/tools/pending.ts:86` `expectOk(..., "list pending permissions")` → "The delegate server failed to list pending permissions"). `oc_answer` 04:18:25Z failed ms=18 with `upstream_error` — answer requires re-listing via `findPending` (`src/tools/answer.ts:69-81`), so a failing box list blocks answering. Direct probe of the same endpoint now (session closed) → HTTP 200 `[]`; earlier probes of deleted-session paths returned HTTP 500 from the box server. Box state during the failure: SSE reconnect loop, 22 sessions tracked at once (`box ready ... sessions:22` 2026-10-08T05:15Z), mem 2.5/4 GiB — the boxed `opencode serve` failing/500-ing under load is the most consistent trigger.
- The stuck session was resolved by force: `oc_close_session` aborted it at 04:30:09Z (log `abort sent before closing a session`, status 200; `closeSession done ... uncollectedCommits:0`). Its host record is removed.
- `oc_wait` events already carry `requestID` (`src/tools/wait.ts:29`), but `oc_answer` won't accept an id not in the fresh `oc_pending` listing — the listing is a hard dependency (`answer.ts:61-63` for approvals, `findPending` for permissions). Improvement #3 is exactly this coupling.

### B2 — syncRef fails at the git level (root cause found)
`logs/bridge-2026-10-08.log`: `sync failed ... detail:"fatal: couldn't find remote ref HEAD"` at 04:58:29Z and 05:14:34Z — matches the owner's two attempts. `workspaces.ts sync()` does `git fetch --quiet <bundle.boxPath>` with NO refspec (`src/supervisor/workspaces.ts:334`); a bundle has no default HEAD ref, so git asks for `HEAD` and fails. The `tempRef` created host-side (`refs/delegate-sync/<nonce>`) is never named in the fetch. Deterministic: fails 100% of the time. Fix: `git fetch --quiet <boxPath> <tempRef>`. (#143 feature; owner hit it first.)

### B3 — the "server drop" at 04:53Z was the box being recreated
Box container `StartedAt=2026-10-08T04:53:40Z`; gate logs `event:"started"` 04:53:40.321Z. Bridge log shows `starting sandbox ... port:56544` at 04:53:30Z (a reuse-check or sibling failure forced a replace). Sessions and clones survived on box volumes; `oc_wait` returned empty because the hub's SSE died with the old instance (drop handling: `src/events/hub.ts:287-297`). Work survived; the caller got no terminal event telling it to re-wait. The `hubChanged` terminal path exists (`wait.ts:51-58`) but only fires for a bridge that re-runs `box()`; an idle bridge never re-swaps (`runtime.ts:102-105`), so its `oc_wait` times out with `unknown`/`server_down` views. (Partially improved by #150: `formatViewState` now surfaces `lastError` / `[no activity for N min]`.)

### B4 — deps in the box: npm cache IS reachable, pnpm is not
Box env: `BUN_CONFIG_REGISTRY` / `npm_config_registry` → npm-cache (verdaccio), `PIP_INDEX_URL` → pypi-cache. So `bun install` / `npm ci` / `pip install` work inside the box; the repo's `node_modules` is never bundled in (bundle excludes it), and no pnpm is on PATH in the box image (`docker/box/Dockerfile`). A delegated builder can install deps; it didn't (and couldn't with pnpm). The "62 tests passed" false-green is the un-verified-claim class — host-side `oc_verify` (#142/#147) exists but was not used for the full suite.

### B5 — "Synapse requires login" = the buddy-review path needs a credential the box can never have (corrected by arch review)
`synapse_buddy_review` reads `~/.local/share/opencode/auth.json` for a token (`packages/opencode/src/plugin/synapse.ts:1980-1991`) and POSTs to `synapse-mcp.alterspective.com.au` (`synapse.ts:2006`). Inside the box: no auth.json (credential stays host-side, #48) and that host is not in the egress allowlist. The box agent is nevertheless *instructed* to call it (`synapse.ts:1837-1838`), so the built-in review step is a guaranteed failure that burns build time. (Not the Keystone `/mcp` 403 originally implied.)

### Bridge hygiene (found during live checks)
- Three `claude-main` bridge processes; PIDs 109916 and 90544 still alive (bun); 95616 dead with lease file still present. 90544's hub keeps an OLD box target from before the 04:53 recreation, producing the endless `event stream dropped: Unable to connect` + `inbox_unavailable` warn spam (thousands of failures) in the shared log at the time of investigation — the loop is NOT the live bridge failing; direct probes of 56544/56546 answer 200. Zombie bridges never call `box()` so they never re-swap targets (`src/runtime.ts:102-105`, `swap()` only runs inside `ensure()`).
- Gate container logged `[Bun.serve]: request timed out after 10 seconds. Pass idleTimeout` — Bun's default 10 s idleTimeout kills long-poll SSE/stream connections (matches improvement #5 and the reconnect loop class). The same defect exists in the inbox sidecar (`inbox-sidecar/src/main.ts:56-57`): both `Bun.serve` calls pass no `idleTimeout`.

### Already addressed by #150 (HEAD 515344a, after much of the owner's window)
- `#140` readonly bash allow-list (git status/log/diff/show/branch/rev-parse, cat, head, tail, grep, ls, pwd, find, sed -n) — `src/guard/permissions.ts`. Owner's list asked `rg` — still missing.
- `#143` syncRef (shipped broken, see B2), `#142/#147` verify/land, `#148` allowedPaths, `#136/#139` git identity + error telemetry, `#137/#144/#145/#146` isolation/close.
- `oc_wait` MAX_WAIT_SEC is 240 (the owner's "120 s then background" is the client tool timeout, not the bridge cap).

## Mapping owner asks → code surfaces
- Imp1 (model default): `src/tools/send.ts` model default path + README Models section + `src/synapse/models.ts`.
- Imp2 (readonly shell): `permissions.ts READONLY_BASH_ALLOW` (add rg, wc, sort, uniq, nl, stat, du, file, git blame/describe/tag).
- Imp3 (answer without listing): `answer.ts findPending` — resolve directory from the host record (`boxPathOf(sessionKey)`) + ownership via `ownSession`, keep the id prefix check; the pending list then is convenience, not gatekeeper.
- Imp4 (truncation): `result.ts lastAssistant` (8000/count budget) + `shape.ts` cap drops-from-end → for single reply keep head+tail or page by messageID cursor.
- Imp5 (longer waits / notify): `sse.ts` idleTimeout (gate has the Bun issue; check front/sidecar too), `wait.ts` cap vs client timeout, `--channels` push (built, off by default), `cli.ts watch`.
- Imp6 (dynamic by default): `src/shared/config.ts DEFAULT_KEYSTONE` is clean; the saved set and gate containers on this PC still carry `dynamic`; doctor/README make mismatch symptoms confusing (B1's two failure modes). Housekeeping: re-set the box keystone set without `dynamic`, or raise this bridge's ceiling deliberately.

## Architecture review (2026-10-10) — verdicts and plan

All OB root causes CONFIRMED against code. Corrections/precision:
- OB-1 mode (b): the box `/permission` 500-under-load trigger is plausible but UNPROVEN (upstream route, not reproducible from bridge code). The fail-closed coupling in `oc_answer` is confirmed.
- OB-3: drop handling is `hub.ts:287-297`; the terminal-event gap only bites bridges that never re-run `box()`.
- OB-4: `oc_verify` runs on the HOST — wiring the builder's verify step is a process/instructions change, not new code.
- OB-5: corrected mechanism (buddy-review token+host missing in box; the box agent is even *instructed* to call it - `synapse.ts:1837-1838`).
- OB-8: the `apr_` approval path MUST stay coupled to a fresh gate read (approvals live only in gate memory); decoupling applies to `per_/que_` only.
- OB-10: the missing `idleTimeout` also exists in the inbox sidecar (`inbox-sidecar/src/main.ts:56-57`), not just the gate.

Tier 1 quick wins (low blast radius, security-neutral):
1. `workspaces.ts:334` - add the bundle refspec `<tempRef>` to the sync fetch (+ regression test: bundle without HEAD).
2. `permissions.ts` - add `rg/wc/sort/uniq/nl/stat/du/file/git blame/git describe` to READONLY_BASH_ALLOW.
3. Set `idleTimeout` on both `Bun.serve` calls (gate main.ts:43-44, inbox-sidecar main.ts:56-57).
4. Doctor: on ceiling mismatch, lead with the keystone problem+fix; make the gate line truthful ("not checked: this bridge's set is outside ceiling") instead of "sandbox not running".
5. `pending.ts`: isolate per-directory read failures (settleAll style) - one failing directory becomes `partial`, no longer fails the whole listing/answer.
6. Doctor lists live leases (PID + heartbeat) so zombie bridges are visible.

Tier 2 design items (owner decision):
1. `oc_answer {sessionID}` fallback: ownership + directory from the host record (`ownSession`), id shape + kind-prefix + reply-word checks kept, box POST 404 is the liveness proof; the fresh listing becomes the normal path, not the gatekeeper. Question: require sessionID for the fallback (safer) or probe?
2. Doctor/status verdict split: a ceiling violation must not erase box facts (report `running` + `ceilingMismatch:[ids]`; `verified` stays false; ensure() still refuses). Question: allow read-only tools for a mismatched bridge, or keep total refusal?
3. `oc_result`: head+tail budget split (tail wins) + messageID paging.
4. Model default policy (coder default vs auto + fit table) - product decision.
5. dynamic removal: owner runs `oc_server_restart {keystone:[rag-read,github,seqlogs]}`; this bridge's default ceiling then fits.
6. Builder deps: document caches + install-then-verify in session instructions; question: auto `bun install` at session open?

Tier 3 docs: README model-fit table; "no node_modules/pnpm" first-run note; self-review unavailable in box; file the upstream `/permission` 500 issue (watch list, like U-1/U-2).

DO NOT: answer `per_/que_` from the id alone without ownership proof; accept `always` through any new path; drop the box-side POST existence check; report `policyVerified:true` when the comparison cannot be computed; widen installs beyond the read-only caches; allow interpretable commands (`sh -c`, `node -e`, `python -c`) in the readonly list; skip the gate read for `apr_`; auto-promote a model-default change without the owner's call.

## Tier 1 — DONE 2026-10-10 (branch `ocd-owner-feedback`, worktree `X:\opencode---ocd-owner-feedback`; full suite 1272 pass / 0 fail / 43 pre-existing skips; typecheck 0)

1. OB-2 syncRef: `workspaces.ts:334` fetch now names `tempRef`; regression test reproduces the production error (`fatal: couldn't find remote ref HEAD`) when reverted, passes with the fix (`test/workspaces.test.ts`).
2. OB-7 readonly list: `permissions.ts` +`rg wc sort uniq nl stat du file` +`git blame* git describe*`; allow/deny cases incl. `sh -c`/`node -e` stay `ask` (`test/guard-permissions.test.ts`).
3. OB-10 idleTimeout: `mcp-gate/src/main.ts` + `inbox-sidecar/src/main.ts` — both listeners `idleTimeout: 130`.
4. OB-1/OB-11 truthfulness: `status.ts` returns `running` + `ceilingMismatch:[ids]` (policyVerified/frontMatches fail-closed false) instead of `unavailable` when only the ceiling differs; `ensure()` still refuses (test proves `policy_violation` on ensure and zero compose up calls). `doctor.ts`: summary says "the sandbox IS RUNNING … outside its ceiling" with both exits; gate is PROBED for real despite the mismatch (`reachable` now truthful); new `leases` section (pid/alive/heartbeat/idle, newest first, cap 20, missing folder = empty). `login.ts`: `runningApi` refuses a ceiling-mismatched box (no sign-ins attached to a box outside this bridge's ceiling). Tests: `test/doctor-ceiling.test.ts` (6 cases) + extended `test/keystone-ceiling.test.ts`.
5. OB-1b pending isolation: `pending.ts` readList catches per kind/directory → `failedReads {count, codes}` + `partial`; healthy sessions stay listable AND answerable while one directory 500s; ids only in a failed directory refuse with the code + oc_doctor advice, never a guessed POST (`answer.ts` text only). Tests extended in `test/tools-interaction-answer.test.ts` (one old all-or-nothing assertion updated from throw→partial, deliberately).

## Tier 2 decisions — as taken 2026-10-10

**D1 oc_answer fallback — DECIDED (owner: require sessionID) and BUILT.** `oc_answer {requestID, kind, reply, message, sessionID}`: normal path unchanged (fresh listing first, `via:"list"`). When the listing cannot confirm the id (partial, or not found and sessionID given), the host record proves ownership (`ownSession`: same sessionID + supervisor in MY record; a foreign/subagent-not-listed id refuses before any POST, subagents answer via their parent), the directory derives from the session key, and the box POST is the liveness proof (404 = no longer pending). Guard rails kept: id regex + kind prefix, `always`/unknown reply words, never answers on a listing that merely *omitted* the id without a sessionID. Question `answers` stay listing-bound (count proof only from the listing); with sessionID only reject. `apr_` unchanged (fresh gate read mandatory). `PendingItem.untrusted` now optional (absent on the fallback — honest: never listed). 5 new test cases incl. the exact #1411 repro (partial + guessed id refused; same id with sessionID answered to DIR_B; POST 404 path). README security row + tool table updated. Full suite 1276 pass / 0 fail; typecheck 0.

**D2 mismatched-bridge visibility — DECIDED (owner 2026-10-10, option B).** Question was: a bridge whose ceiling excludes the saved set may read session data (status/result/wait/list) from a box another bridge started? Owner's answer recast the problem: **keep `dynamic` on the shared box — the box must NOT be limited.** Narrowing lives at the client, not the sandbox: every bridge on this home must carry the matching ceiling. Done in X:\opencode\.opencode\opencode.jsonc — opencodealt bridge registered with `OPENCODE_DELEGATE_KEYSTONE_ALLOWED=rag-read,github,seqlogs,dynamic`, `OCD_KEYSTONE_HOST_AUTH=1` and `OPENCODE_DELEGATE_DYNAMIC_PROFILE` mirroring claude-main's ~/.claude.json entry (equality avoids profile_changed/flag-refusal), distinct `OPENCODE_DELEGATE_NAME` (session ownership), roots extended `C:\GitHub;X:\`. Read-only widening NOT taken; total-refusal semantics stay. Live doctor with the exact new env: box running, guard/egress/live ok, gate reachable (0 waiting), all four connections signed in through the shared host token store; `verified` false ONLY on `imageMatches` (box built at 515344a, checkouts at f8524b2) — the next box restart rebuilds the image and both bridges verify. The high-risk `dynamic` warning stays by design.

**D3 oc_result truncation — DECIDED (owner: head+tail with paging) and BUILT.** `shape.ts headTail`: over-budget replies keep 40% opening + 60% ending (verdicts live at the close), marker names the skipped length and the paging offset; budget reserved so the cut never exceeds it. `result.ts`: single-reply budget 8k front-cut → 12k head+tail (`REPLY_BUDGET`, divided across `messages`), each reply carries `textTotal` and a `textHint` when cut; new paging mode `oc_result {sessionID, messageID, textOffset}` returns 12k windows, `textNext` until the end; a message the session replaced mid-page is `not_found`, never a wrong window. Reply shape kept contract (`untrusted` fence). Full suite 1278 pass / 0 fail, typecheck 0. One-off `tools-close` #146 failure in a loaded parallel run is a known real-git flake (passes standalone in 47s; code untouched by D3). README `oc_result` row updated.

**D4 model fit — DECIDED (owner: the fit table comes FROM Synapse + hint the work needed; stage 1 + file stage 2) and BUILT.** Reframe accepted: a README table goes stale; Synapse has the benchmarks, so the table must travel in the catalogue. Key finding: `auto` ALREADY receives "this is code" (`x-task-type: code`, plugin synapse.ts:995 — fires exactly in the box's no-auth state), so #852's slow run was cost-first routing, not a missing signal.
- Availability guarantee (pre-existing, verified): box offers only Synapse's registered list at start (chat+tools capable filtered, #71/#80), `requireModel` checks every send against the box list, #149 live pre-flight refuses retired/no-longer-served named models with alternatives. Fit scores extend this without weakening it.
- **Stage 1 (built here):** `synapse/models.ts` parses `capabilities.suitability` (0..1, malformed dropped, fail-open); new `bestForRole`/`pickRoleModel`/`rolesTable` in `tools/models.ts`; `oc_send {taskRole}` and `oc_start_session {taskRole}` set the model to the best OFFERED fit (never auto, never a retired model), result carries `taskPick` (model+score, or fellBack reason); `oc_list_models` returns discovered `roles` (ranked, capped) — vocabulary is Synapse's, zero consumer hardcoding. Explicit `model` still wins over `taskRole`. Tests: `test/models-task-role.test.ts` (12 cases incl. pure-pick, unknown-role fallback, send/start wiring).
- **Stage 2 (filed):** Alterspective-Engine/Alterspective-Synapse#1918 — publish suitability on `/v1/models`, accept `x-task-role` in `auto` routing, ignore unknown roles, per-privacy-class note, telemetry correlation. When it lands the consumer flips to `auto`+header and the client pick retires. Contract draft: `evidence/synapse-contract-issue.md`.
