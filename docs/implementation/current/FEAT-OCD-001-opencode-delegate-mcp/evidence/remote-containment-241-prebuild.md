---
id: OCD-241-REMOTE-CONTAINMENT-PREBUILD
title: Remote delegate containment proposal and prebuild review
status: active
category: implementation-evidence
---

# Remote delegate containment — proposal and AIRUN-058 record

**Current record:** named approval is recorded in the later appendix. Package verification has now run; see the [verification and delivery checkpoint](#verification-and-delivery-checkpoint). The frozen proposal and its original pending-state wording below are historical.

**Date:** 2026-10-25 UTC / 2026-10-26 AEDT
**Timed review phase:** 13:10:11–13:23:55 UTC; original consult start time was not retained.
**Issue:** [Alter-Igor/opencode #241](https://github.com/Alter-Igor/opencode/issues/241)
**Decision owner:** Igor Jericevich
**Architect:** independent Codex token_delivery_architect session, not the implementer
**Implementer:** token_code_delegate_setup, sole scoped code and issue-progress writer
**Worktree:** `X:\opencode---fix-241-delegate-remote`
**Branch / source:** `delegate-remote-fix` at `c4fa54c46bfeadd0b9488703161686cb1901b52f`
**Deployed service source:** `acfcb8bbe7fd6187f0f650347be066496402917b`
**Status:** proposed; no executable edits authorized by this record

## Owner decision

Approve a containment fix that blocks new remote delegation and removes false readiness claims. It will report actual health and authenticated-read observations while saying remote execution policy is unverified. It will **not** make the remote backend usable. Keep #241 open for a separately designed execution contract.

Three independent model reviews have returned. Their reported costs total USD0.221637. The verified findings tightened the refusal and diagnostic requirements below. Executable work remains blocked until Igor approves this contract; model agreement does not grant that approval.

The alternative is no code change and keeping remote delegation unused until that contract is designed. A staged create/send handoff is excluded: it needs durable logical/task identity, first-send concurrency and retry recovery while still lacking permission/model-policy equivalence.

The repaired default local backend is separate: its actual doctor passed, but no task ran because moving five saved records remains unapproved. A fresh isolated profile reached normal SSO but met Docker address-pool exhaustion. This proposal authorizes no move, cleanup or real task.

## Inputs and preflight

| AIRUN-058 check | Result |
| --- | --- |
| P1/P1B FEATURE_REQUEST | Contain unsupported remote execution for #241 without inventing fields or parity. General fix requested; exact containment approval pending. |
| P1A DATA_CLASSIFICATION | Internal engineering source. Parent authorized source-only review; no client identifiers, credentials, prompts or user records. |
| P2 TARGET_REPO_ROOT | Exact worktree above; git rev-parse returned that repository. Aio worktree list confirmed delegate-remote-fix. Initial git status/diff were clean. |
| P3 KNOWLEDGE_BASE_ROOT | C:\GitHub\Alterspective-Intelligence; architecture standard existence observed. |
| P3A configuration | N/A: no new setting, environment variable or feature flag. Reuse existing URL, token and deadline seams. |
| P4 ADR mechanism | docs/architecture/decisions absent. No standards exception is proposed; see explicit Step 6 conflict/disposition below. |
| P5 Synapse | Authenticated live catalog returned 33 models at 2026-10-25T13:10:11Z. Exact selection below. |
| P6 source safety | PASS: redacted gitleaks directory scan exited 0 with no leaks before review submission; only the delimited source pack and neutral system framing were sent. |
| Executable implementation | NOT STARTED. Dependency install and pre-fix fixture reproduction are not a deployed task or implementation pass. |

## Step 1 — classify and lock scope

**High-risk:** public MCP execution admission, a security boundary and cross-service behavior change. AIRUN-058 Step 1 selects the highest matching class; tightening the guard does not lower it.

ARCH-GATE-01: EXTEND opencode-delegate remote adapter class=High-risk reviewer=Codex-token_delivery_architect-session rules=ARCH-GATE-01,ARCH-GATE-03,ARCH-EXT-04,AIMETH-010

This records the existing path and class. It is **not an implementation GO**. Three usable independent reviews and named owner approval remain required.

## Step 2 — governing baseline and existing path

Read repository AGENTS and relevant Web routing, BUILD-FOR-AI, architecture, API, security and configuration standards. RAG matched LIF-001-30; this task performs its prebuild consultation only. AILES-211 and AILES-022 require host verification and explicit treatment of missing results. RAG/registry searches found no additional applicable card; actual existing adapter and deployed service sources establish EXTEND.

| Constraint | Proposed acceptance/disposition |
| --- | --- |
| SOLID/layer direction | Existing runtime composition root wires a narrow optional context readiness port. Tools do not import service implementations. Final imports must be checked. |
| Dependency inversion | Retain OpencodeApi, ToolContext and remote client boundaries. No provider framework or new service. |
| Contract-first | Frozen operation table below plus existing MCP schemas define refusal/diagnostics before code. Service strict schema is authority and is unchanged. |
| ARCH-EXT-04 isolation | Unknown remote permission/MCP/egress equivalence cannot be verified. New remote execution is refused. |
| Stored-fact check | DERIVE each diagnostic from measured reads with time/status. No durable readiness flag, registry, task mapping or duplicate policy store. Old host records untouched. |
| Configuration | REUSE existing backend selection and URL/token/timeout configuration. No new hardcoded endpoint, credential or model list. |
| ARCH-ASSESS-06 / SVC-DECOMP-01 | N/A to new adoption/decomposition: no new tool, dependency, provider, deployable or infrastructure. |
| Evidence | Authenticated read is not execution permission or model identity. Fixtures are hermetic proof, not deployment evidence. |

## Steps 3–5 — placement, proportionality and frozen implementation contract

All five source files are inside `alterspective/delegate-mcp/`:

| Allowed source | Owning change |
| --- | --- |
| src/runtime.ts | Refuse remote box acquisition/restart/exec and unsupported supervisor operations; remove fake held-box/callback/local-policy passes. Wire readiness. Local branch unchanged. |
| src/remote/api.ts | Independently refuse create/prompt before seed/start. Remove fabricated models/MCP/catch-all success. Shared typed refusal may live here if reused. |
| src/remote/client.ts | Bounded read-only health/auth observation, validating status/body and sanitizing output. |
| src/tools/context.ts | Optional narrow read-only remote-readiness port, absent in local mode. |
| src/tools/doctor.ts | Remote diagnostic branch before local checks; always verified:false and policy_unverified. |

Tests may change existing test/remote-runtime.test.ts, test/remote-client.test.ts and one focused adapter test; package README explains containment. No dependency/package script change, upstream core, hub, workspace, types or ID mapping edit. Necessary scope expansion returns to this review first.

| Operation | Required proposed behavior |
| --- | --- |
| Remote oc_start_session/code_start_session | Typed policy_unverified before workspace capture/write/bind or task submission, even with default options. |
| Remote oc_send/code_send/delegate_task aliases | Same refusal for saved/old-like IDs and all engine selections; no adoption, sync or scheduling. |
| ctx.box/restartBox/boxExec/apiFor and supervisor ensure/replace/login | Typed policy_unverified refusal, no synthetic success or alternative unguarded API route. |
| peekBox/onBox/status/verifyLive | No held box or fake binding event; unavailable/unverified facts with reason. |
| Adapter create/prompt | Refuse independently for direct/internal callers, before getSeedPatch/client.startTask. |
| Unsupported models/MCP/unknown paths | Explicit unsupported result, never hardcoded facts or empty HTTP 200. |
| Remote doctor, including start:true | Only bounded anonymous health and configured-token authenticated repos reads. No start, OAuth/client-credential grant, refresh, Docker, local sign-in/front/egress/home-token/lease checks. Missing configured token means protected read not observed/needs_auth. Always verified:false. |
| Local backend | Existing behavior and guards preserved. |
| Old remote status/result/collect | No usability or parity promise; no identifier redesign, saved-record migration or old-session mutation. |

**ABSTRACTION=NOT-JUSTIFIED** beyond existing client/context seams. The optional read port is justified by two existing backend implementations and real runtime test isolation. No registry, task store or orchestration layer.

## Step 6 — architecture decision and exception disposition

Proposed decision: fail closed until the service can represent and prove the bridge's execution policy. No new service, technology, integration, architectural pattern or standards exception is proposed. This record documents the choice, alternatives and rollback.

AIRUN-058 Step 6 says no conflicting constraint means ARCH-ADR=NOT-REQUIRED, but its later Step 6B sentence says Standard/High-risk MUST use the exception branch. That conflicts with the conditional and the architecture standard's exception-only process. **This is an open procedure interpretation for owner acceptance**, not a self-approved exception. If the owner requires a separate ADR, create/select it before executable edits; this single-file authorization does not create an exception register.

## Step 7A — three independent frontier reviews

Three one-pass independent reviews through Synapse; no automatic retry/substitution; 150-second deadline per call. Parent explicitly capped this work at three calls. Family-selection and privacy guidance was read from multi-model-advisory-review, but its full two-round workflow is **not claimed performed**.

Catalog selection (all routable:true):
- anthropic/claude-opus-5 — Anthropic; USD5 input/25 output per million.
- openai/gpt-5.6-sol — OpenAI; USD5/30 per million.
- google/gemini-3.1-pro-preview — Google; USD2/12 per million, benchmarkScore1.

The newer OpenAI GPT-6 alias lacks declared pricing/output cap. The priced frontier-capable GPT-5.6 entry keeps this review estimable; missing rates are never zero. Max output 8192 per call gives reasoning headroom. A conservative 60,000 input tokens per call plus all output caps estimates USD1.268864 total from catalog rates. Actual provider dollars remain unknown until returned; this is not a hard spend guarantee.

Direct REST carries explicit pins and x-allow-fallback-models:false, x-privacy-tier:cloud-ok, x-task-type:code. MCP chat lacks the fallback-header argument, so direct API is needed for this strict request. Count only matching, usable returned model reports; they do not independently verify weights.

**Results:** three usable, exact reported-model matches returned; selected receipts and verified dispositions follow the source pack. No retries or substitutions.

## Steps 8–10 — approval, handoff and follow-up

**ARCH-REVIEW: NO-GO — named owner approval and recorded procedure dispositions pending.** Three required reviews have returned; their verified dispositions are below.

AIRUN-058 Step 8 states: “For Standard and High-risk work, GO additionally requires named human approval.” Capture Igor's approval of this exact containment contract. The separate 45-hour merge/deploy grant does not satisfy it.

After approval, the sole implementer runs the focused acceptance and full package gates, then obtains final-head CI/reviews and nonauthor ARCH-GATE-02. No review/test authorizes a global install, remote task or production promotion.

Rollback: revert this containment patch through normal review. That restores unsupported old code; it does not authorize using it. No schema, user-data or infrastructure migration.

## Acceptance and verification recipe

Run Bun work through the workstation queue from alterspective/delegate-mcp, never repository root. Focused command proposed by implementer:

```powershell
& 'C:\Users\IgorJericevich\Desktop\This Rig\scripts\automation\work-queue\bin\thisrig-work-queue.exe' run --lane light -- 'C:\Program Files (x86)\Nodist\bin\node_modules\bun\bin\bun.exe' test --timeout 30000 ./test/remote-runtime.test.ts ./test/remote-client.test.ts
```

Use Bun.serve on 127.0.0.1 with port 0, actual initialized SDK MCP Client/InMemoryTransport/server and createRuntime with fixture remoteUrl/token. No global fetch mock or cloud request. Assert zero task POSTs and zero workspace/old-record writes; do not merely match error text.

Cases: both aliases; start default/readonly/model; send old-like ID; delegate_task engines auto/deepseek/opencode; direct adapter create/prompt; models/MCP/unknown unsupported. Healthy+valid-auth positive control still verified:false. Degraded HTTP 200/malformed/503/timeout and protected-read 401/403/network failure preserve only allowlisted status/outcome/shape/elapsed observations and unknown policy. Missing token must not invoke the existing canary grant or local sign-in/refresh path. Sentinel repository/token values in malformed bodies must not appear in output or logs. Actual MCP initialization must finish with non-emitting onBox and no background pollers. No local Docker/sign-in/front/lease/home-token checks. Mutate runtime and adapter guards separately to prove no-write/no-POST assertions detect them. Then run exact package typecheck and complete package tests; retain exits/counts separately. No live cloud task is required or authorized.

## Existing fixture reproduction

Builder-reported native queued Bun 1.3.14, light lane, PID 14404, tool chunk 8e4ed1; injected fetch only, no DNS/network/cloud task. Create title TITLE_ONLY plus deny-edit permission, then send REAL_TASK with providerID/modelID:

```json
{"fixtureOnly":true,"tasksBeforeSend":1,"tasksAfterSend":1,"goal":"TITLE_ONLY","modelForwarded":false,"permissionForwarded":false}
```

Existing remote-client baseline: 9 pass / 0 fail, 24 assertions, native queued PID 88336. Architect did not repeat either check. This is fixture evidence, not a deployed task. Post-fix evidence remains pending.

## Exact outbound source review pack

<!-- BEGIN REVIEW-PACK -->
Decision: review the smallest fail-closed containment for OpenCode delegate issue #241. Recommend ADOPT containment, or identify a concrete blocker. Do not design a working remote backend or claim this enables it. Root will ask the human to approve the final named contract after these reviews. Source-only internal engineering context; no client data, credentials or task text.

System: a local stdio MCP bridge exposes legacy oc_* and modern code_* tools. Local mode runs guarded Docker OpenCode sessions. An existing remote adapter translates an OpenCode-like session API into the separately deployed svc-coding-agent REST task API. The remote adapter currently claims local-equivalent readiness and drops caller intent. User wants a usable coding delegate, but the current remote contract cannot represent the local permissions/model/session contract. The local repair passed its own doctor; its real task still awaits approval for five saved-session records. No cloud task or inference smoke is authorized by this containment plan.

Identities: OpenCode base c4fa54c46bfeadd0b9488703161686cb1901b52f; service source acfcb8bbe7fd6187f0f650347be066496402917b. No executable edits have started. One implementer owns this isolated worktree.

Actual deployed strict request schema (src/app/schemas.ts, selected exact lines):
export const startTaskShape = {
  repo: z.string().min(3).max(200),
  goal: z.string().min(1).max(8000).optional(),
  issue: z.number().int().positive().optional(),
  baseRef: z.string().min(1).max(200).optional(),
  engine: z.string().min(1).max(50).optional(),
  publishMode: z.enum(['github-pr', 'direct-patch']).optional(),
  seedPatch: z.object({ patch: z.string().min(1).max(5_000_000) }).optional(),
  idempotencyKey: z.string().min(1).max(200),
};
export const StartTaskSchema = z.object(startTaskShape).strict();
Other supported fields omitted from this excerpt: acceptanceRef, purpose, requireChange and declared limits (limits are explicitly refused as unsupported). There is NO model, agent, readOnly, system or permission request field. The domain StartTaskRequest also requires idempotencyKey. POST /api/v1/tasks parses StartTaskSchema before scheduling; idempotency-key header may supply the key if absent in the body. GET /api/v1/repos is a real bearer-protected read returning {repos:[{repo,repoClass,residency}]}; it proves read acceptance, not execution permission. GET /health is anonymous. Full health computes 'unhealthy' for database failure (HTTP503), 'degraded' for failed dependencies (HTTP200), else 'healthy' (HTTP200). Merely receiving HTTP200 is not proof of health.

Current remote/api.ts:
const activeTasks = new Map<string, { repo: string; goal?: string; agent?: string; model?: string; started: boolean; permission?: unknown }>()
// POST /session:
const body = input.body as { title?: string; permission?: unknown; metadata?: { sessionKey?: string } } | undefined
const sessionKey = body?.metadata?.sessionKey ?? `rem-${Date.now()}`
const seed = options.getSeedPatch ? await options.getSeedPatch(sessionKey) : undefined
const repo = seed?.repo ?? "default/repo"
const taskReq = { repo, goal: body?.title ?? `Delegated session ${sessionKey}`, publishMode: "direct-patch",
  ...(seed?.patch ? { seedPatch: { patch: seed.patch } } : {}) }
const task = await client.startTask(taskReq)
const sessionId = toSessionId(task.id)
activeTasks.set(sessionId, { repo, goal: taskReq.goal, started: true, permission: body?.permission })
// POST /session/:id/prompt_async:
const body = input.body as { parts?: Array<{ type: string; text: string }>; agent?: string; model?: { id?: string; providerID?: string } } | undefined
const promptText = body?.parts?.find((p) => p.type === "text")?.text ?? ""
const existing = activeTasks.get(sessionId)
if (existing && !existing.started) {
  await client.startTask({ repo: existing.repo, goal: promptText, publishMode: "direct-patch",
    agent: body?.agent ?? existing.agent,
    model: body?.model?.id ? `${body.model.providerID ?? "synapse"}/${body.model.id}` : existing.model })
  existing.started = true
}
return { status: 204, data: undefined }
// GET /models returns three hardcoded models; GET /mcp returns fake ks-identity and ks-rag-read connected.
// Any other path returns HTTP200 with {}.

Current remote/client.ts:
startTask(req) spreads req and adds idempotencyKey: req.idempotencyKey ?? a fresh Date.now()/Math.random key for each attempt.
health() resolves auth headers, GETs /health without its ordinary request deadline, and returns healthy:res.ok without checking the body.
Authenticated ordinary requests use configured URL/token or the existing token resolver. Keep existing URL/auth mechanisms; do not create credentials, grants or a registry.

Current runtime.ts remote branch:
const remoteBox = { target: { baseUrl: config.remoteUrl, password: "" }, api: remoteApi, hub: remoteHub }
const remoteSupervisor = {
 ensure: async () => remoteBox.target,
 status: async () => ({ state:"running", target:remoteBox.target, imageTag:"remote-svc-coding-agent",
   startedBy:"this-bridge", imageMatches:true, policyVerified:true, frontMatches:true, health:"healthy" }),
 release: async () => {},
 login: async () => "connected",
 replace: async () => ({ ...remoteBox, interrupted:0, keystone:[] }),
 verifyLive: async () => ({ ok:true,
   signIns:{ok:true,names:[],stale:[],unrecognised:0,removedBefore:[]},
   front:{ok:true,loadedConfigMatches:true,mountReadOnly:true,boxMountsOk:true,problems:[]}, problems:[] })
}
ctx.box = async () => remoteBox
ctx.peekBox = () => remoteBox
ctx.apiFor = () => remoteApi
ctx.restartBox = async () => ({ ...remoteBox, interrupted:0, keystone:[] })
ctx.onBox immediately calls its listener(remoteBox)
ctx.boxExec = async () => ({ code:0, stdout:"", stderr:"" })

Current tool ordering:
oc_start_session: resolveRepo (read) -> sessionKeystone skipped for remote -> refuseBusy -> await ctx.box() -> model checks -> workspaces.open (captures patch/writes host state) -> create session -> bind host state.
refuseBusy uses ctx.peekBox; if no held box it returns. Thus a remote ctx.box refusal with peekBox undefined is before workspace creation or host-state binding.
oc_send: await ctx.box() -> ownSession/adoption -> checkPolicy -> optional sync/state changes -> sendPrompt.
checkPolicy currently returns immediately for backend remote, bypassing the local runtime permission/MCP guard.
sendPrompt may add a default Synapse model, an agent and repository system instructions; actual model shape has providerID/modelID. Tool message cap is100000 chars and instructions may add12000, while the service goal cap is8000.

Existing remote hub and workspace layer:
hub assumes sessionID reversibly encodes taskID; status polls getTask(toTaskId(sessionID)). Workspaces persist sessionID and collect uses it for getPatch. A deferred create/send design would require durable logical-session/task-ID mapping and restart/concurrency/idempotency recovery across both. Do NOT implement that in this patch.

Observed pre-fix fixture-only reproduction (builder-run, not independently repeated by architect):
createRemoteOpencodeApi POST/session title TITLE_ONLY + deny-edit permission, then prompt_async text REAL_TASK + model {providerID:"synapse",modelID:"auto"}.
Result: {fixtureOnly:true,tasksBeforeSend:1,tasksAfterSend:1,goal:"TITLE_ONLY",modelForwarded:false,permissionForwarded:false}.
Injected fetch only, no DNS, no cloud task, no inference. Existing remote-client baseline9pass/0fail.

Proposed frozen containment contract:
1. Only five production files: src/runtime.ts; src/remote/api.ts; src/remote/client.ts; src/tools/context.ts; src/tools/doctor.ts (all under alterspective/delegate-mcp). Existing test/remote-runtime.test.ts and test/remote-client.test.ts, a focused adapter test if needed, and package README are the only test/doc implementation surface. No extra dependencies, env vars, schema/registry changes or upstream core edits.
2. Runtime remote ctx.box, restartBox, boxExec and supervisor ensure/replace/login must throw a stable typed policy_unverified refusal. peekBox is undefined; onBox does not emit a fictitious held box. Supervisor status/verifyLive report unavailable/unverified with reason, never fabricated pass facts. Local mode is unchanged.
3. Adapter POST /session and /session/:id/prompt_async independently refuse before seed capture or client.startTask. Unsupported /models,/mcp and unknown paths return explicit unsupported errors instead of hardcoded model/MCP facts or catch-all200. Do not implement logical sessions, fix send translation, or promise old remote status/result/collection parity.
4. Add an optional narrow remote-readiness hook on ToolContext, wired at the existing composition root to the client. Remote oc_doctor/code_doctor takes this read-only path before local Docker/egress/sign-in/home-token/lease checks. start:true must not start anything.
5. Readiness uses only bounded GET /health and authenticated GET /api/v1/repos to the configured remote service. Public health must be separable from auth failure. Validate health body status; verify protected read status and expected JSON shape. Keep only status/outcome facts, not repository names, tokens or response bodies. 200 degraded is not healthy. Authenticated catalog read is not execution authorization, MCP-policy proof or readiness to run.
6. Always remote doctor verified:false and policy_unverified because actual remote MCP, egress, permission/readonly and model policy remain unknown. No empty array or zero count may imply a check ran or passed.
7. No cloud task, local sandbox restart, global install, five saved-record migration, Docker prune, provider/model registry mutation or rollout. Keep issue241 open for the usable remote execution contract. Roll back by reverting this containment patch; that does not authorize running the old unsafe path.

Required acceptance evidence after human approval:
- Real initialized SDK MCP Client + InMemoryTransport + actual bridge server/runtime, with Bun.serve loopback fixture via existing remoteUrl/fake test token. No global fetch mocks or external service.
- Both oc_* and code_* aliases: start default/readonly/explicit-model; send old-like session ID; delegate_task engine auto/deepseek/opencode all refuse policy_unverified before any task POST, seed/workspace write or old-record change.
- Direct adapter create and prompt refusal, /mcp /models unknown no false200.
- Healthy+valid-auth positive control remains verified:false; degraded200/malformed/503/timeout and auth401/403/network fail preserve exact observations and unknown policy. Ensure no Docker/sign-in/home-token/lease path was touched.
- Full package tests/typecheck per repo AGENTS, not root; inspect changed tests for weakened assertions. Revert guards in a controlled test mutation to prove no-write/no-POST assertions detect them.
- README clearly says remote execution blocked, measured readiness only, local mode unaffected, no remote usability claim.

Review instructions: independent first-pass architecture advice, not approval. Stay within containment. Give a direct recommendation, up to5 concrete findings each tied to a source/proposed clause, classify blocker vs improvement, and name unverified assumptions. Do not infer service permissions or full parity from health. Do not treat a test fixture as deployed proof. Do not prescribe an unrelated migration/registry/deployment. Keep response under700 words; prioritize correctness and trust-boundary holes over generic suggestions.
<!-- END REVIEW-PACK -->


## Step 7A results and verified dispositions

All three calls returned HTTP 200, finish_reason stop, usable text and an exact matching x-synapse-served-model report. No retry, substitution or second round occurred. These are gateway-reported identities, not independent verification of weights. No cloud coding task ran.

| Reviewer / family | Reported tokens input / output | Reported cost USD | Recommendation |
| --- | --- | --- | --- |
| anthropic/claude-opus-5 / Anthropic | 4,449 / 4,798 | 0.142195 | Adopt conditional on four clarified boundary/diagnostic points. |
| openai/gpt-5.6-sol / OpenAI | 2,595 / 1,702 | 0.047012 | Adopt; no concrete architecture blocker from supplied context. |
| google/gemini-3.1-pro-preview / Google | 2,913 / 2,217 | 0.032430 | Adopt; safe containment, no usability endorsement. |

All three cost headers said settled / provider_reported. Total reported cost of these three gateway calls is **USD0.221637** (221,637 micros), below the USD2 target. This excludes the authoring session and any future implementation. Provider invoices were not independently reconciled. Reported token counts vary by provider; no token-reduction or quality experiment is implied.

The source review pack was 11,555 UTF8 bytes, SHA256 `99a0acb381e5874d7a99b1e7351204d9e2cb09237e4851cf1df8cc9252f7942a`. A redacted gitleaks directory scan exited 0 with no leaks before submission. The same delimited pack plus the same neutral architecture-review system framing went to each model. Requests used max_tokens 8192, stream:false, explicit pins, cloud-ok, task-type code, premium and x-allow-fallback-models:false, with a 150-second timeout. The newer GPT6 alias was not substituted or invoked.

| Point | Disposition and checked evidence |
| --- | --- |
| Opus F1: non-emitting onBox causes an indefinite wait | **REBUT blocker claim.** Source `tools/interaction.ts:23–47` calls ctx.onBox synchronously, then peekBox, and returns cleanup; it does not await an event. Global source search found no other ctx.onBox consumer. Throwing during registration could instead prevent MCP/doctor initialization. Keep non-emitting unsubscribe behavior and add bounded actual-SDK initialization/no-poller coverage. |
| Opus F2: enumerate apiFor and raw hub/workspace access | **ADOPT clarification.** Remote apiFor must also throw policy_unverified; direct adapter create/prompt remains the independent second guard. `tools/login.ts:87–94` reaches apiFor only for a running supervisor, which proposed remote status cannot claim. Normal collect/sync/close/cleanup paths obtain ctx.box first (`collect.ts:78`, `sync.ts:18`, `close-session.ts:213,323`). Raw hub/workspace helpers remain outside any usable-remote promise. No ID mapping or old-record mutation is added. |
| Opus F3: anonymous/full health ambiguity | **REBUT factual ambiguity; ADOPT parser requirements.** Pinned service `src/app/server.ts` explicitly maps anonymous /health to h.full; `src/app/health.ts` emits healthy/degraded/unhealthy and degraded can be HTTP 200. Missing/unparseable/unknown status must remain unknown. Bound headers and body reads; preserve timeout/non-JSON distinctions. |
| Opus F4: exact observations could expose response text | **ADOPT.** Existing `remote/client.ts:106–108` embeds response text in generic errors, so new diagnostic output must use an allowlist of HTTP status, outcome enum, shape-valid boolean and elapsed time. Do not reuse raw error-body strings. Add malformed/degraded fixtures with sentinel repo/token values; neither doctor output nor captured logs may contain them. |
| Opus F5: do not repair idempotency/goal/permission parity here | **ADOPT.** Actual strict schema and client source confirm required idempotency, goal cap of 8,000 and missing intent fields. Keep these as prerequisites for #241; sole issue writer records progress. No logical/session-task mapping, prompt translation or idempotency redesign in containment. |
| OpenAI1–2: two guards and one typed refusal | **ADOPT.** Source calls to client.startTask exist only in remote/api.ts; both adapter entry points and runtime acquisition are covered. ErrorCode already includes policy_unverified; `tools/define.ts:27–39` and `shape.ts:92–97` preserve it as an MCP isError result. Explicit unsupported HTTP status is required for adapter read paths, not error-shaped200. |
| OpenAI3–4: independent observations, total deadline, unmeasured local checks | **ADOPT.** Health and protected-read observations must be separable and bounded; no fabricated empty local-check arrays or zero counts. HTTP 200 with authenticated catalog shape still leaves verified:false and remote policy unknown. |
| OpenAI5: no-side-effect tests and separate guard mutations | **ADOPT.** Assert zero task POSTs, seed callbacks, host records and workspace mutations. Mutation-check runtime and adapter boundaries separately. Inspect previous tests expecting fake success as behavioral corrections, not justification to weaken coverage. |
| Google1–2,4: refusal before writes, body fidelity and auth≠execution authority | **ADOPT observable requirements.** Checked tool ordering, requireBearer-protected repos route and full health handler at pinned sources. Actual SDK tests remain required; no guarantee is inferred merely from this source review. |
| Google3: strict schema “to force the request through” | **ADOPT defect, omit motive.** Actual code drops caller intent; why it was written that way is not established. The plan states observable behavior only. |
| Reviewer auth-resolver assumption | **ADOPT a narrower diagnostic contract.** Existing client resolver can mint a coding:admin client-credential token when only a canary secret is present. New doctor must use only its already configured options.token; missing token means protected read not observed/needs_auth, while public health still runs. No grant, interactive sign-in, refresh or home write. Source runtime.ts:249–252 already supplies config.remoteToken, so no new config/auth seam is needed. This is source-verified feasibility, not runtime proof. Existing task-client auth is unchanged and no execution is enabled. |

No reviewer consensus is treated as owner approval. New findings were verified against the named source before adoption. The contract clarifications above are within the same five source files. They have not been implemented or model re-reviewed; the three-call cap was preserved.

### Selected original response receipts

The following preserves actual returned review text and selected response metadata; trailing Markdown whitespace is normalized. No reasoning text, credential, repository list or private runtime response was retained.

```json
[
  {
    "requestedModel": "anthropic/claude-opus-5",
    "responseModel": "anthropic/claude-opus-5",
    "servedModel": "anthropic/claude-opus-5",
    "servedReportMatchesRequest": true,
    "startedAt": "2026-10-25T13:16:09.5231961Z",
    "completedAt": "2026-10-25T13:17:18.2442781Z",
    "httpStatus": 200,
    "finishReason": "stop",
    "usage": {
      "prompt_tokens": 4449,
      "completion_tokens": 4798,
      "total_tokens": 9247,
      "completion_tokens_details": {
        "image_tokens": 0
      },
      "prompt_tokens_details": {
        "cached_tokens": 0,
        "cache_write_tokens": 0
      }
    },
    "costState": "settled",
    "costBasis": "provider_reported",
    "costUsdMicros": "142195",
    "correlationId": "arch241-prebuild-20261025-1",
    "transportError": null,
    "providerError": null
  },
  {
    "requestedModel": "openai/gpt-5.6-sol",
    "responseModel": "openai/gpt-5.6-sol",
    "servedModel": "openai/gpt-5.6-sol",
    "servedReportMatchesRequest": true,
    "startedAt": "2026-10-25T13:16:10.1046350Z",
    "completedAt": "2026-10-25T13:16:40.6830957Z",
    "httpStatus": 200,
    "finishReason": "stop",
    "usage": {
      "prompt_tokens": 2595,
      "completion_tokens": 1702,
      "total_tokens": 4297,
      "completion_tokens_details": {
        "image_tokens": 0
      },
      "prompt_tokens_details": {
        "cached_tokens": 0,
        "cache_write_tokens": 2592
      }
    },
    "costState": "settled",
    "costBasis": "provider_reported",
    "costUsdMicros": "47012",
    "correlationId": "arch241-prebuild-20261025-2",
    "transportError": null,
    "providerError": null
  },
  {
    "requestedModel": "google/gemini-3.1-pro-preview",
    "responseModel": "google/gemini-3.1-pro-preview",
    "servedModel": "google/gemini-3.1-pro-preview",
    "servedReportMatchesRequest": true,
    "startedAt": "2026-10-25T13:16:09.8092430Z",
    "completedAt": "2026-10-25T13:16:35.0631164Z",
    "httpStatus": 200,
    "finishReason": "stop",
    "usage": {
      "prompt_tokens": 2913,
      "completion_tokens": 2217,
      "total_tokens": 5130,
      "completion_tokens_details": {
        "image_tokens": 0
      },
      "prompt_tokens_details": {
        "cached_tokens": 0,
        "cache_write_tokens": 0
      }
    },
    "costState": "settled",
    "costBasis": "provider_reported",
    "costUsdMicros": "32430",
    "correlationId": "arch241-prebuild-20261025-3",
    "transportError": null,
    "providerError": null
  }
]
```

### anthropic/claude-opus-5

## Recommendation

**ADOPT the containment** — the fail-closed direction is correct and the chokepoints (`ctx.box` before `workspaces.open`, adapter refusal before seed capture/`startTask`) are placed on the right side of the write boundary. Adopt conditional on closing F1, F2 and F4 below; all three are clarifications **inside** the frozen five-file surface, not scope expansion. I am not endorsing any remote execution path, and nothing here constitutes a test result.

## Findings

**F1 — `onBox` no-emit can hang instead of refuse (BLOCKER).** Clause 2 says `onBox` "does not emit a fictitious held box." Today `ctx.onBox` invokes its listener synchronously; silence changes a fabricated-success bug into an unbounded wait, which is not a "stable typed policy_unverified refusal" and reads to an operator as work in progress. Require: remote `onBox` either rejects/throws the typed refusal at subscription time, or the review records the enumerated consumers proven not to await a box event. Add a timeout-free-hang assertion to the acceptance list.

**F2 — `ctx.apiFor` (and hub/workspaces entry) not enumerated in clause 2 (BLOCKER).** The runtime excerpt sets `ctx.apiFor = () => remoteApi` and the hub/workspace layer talks to `client.getTask`/`getPatch` via `toTaskId(sessionID)`. Clause 2 lists `box`, `restartBox`, `boxExec`, supervisor methods, `peekBox`, `onBox` — not `apiFor`. Any caller that takes `apiFor()` without `ctx.box()` is then guarded only by clause 3. State the invariant explicitly as two independent layers, enumerate `apiFor` in clause 2, and name the hub/collect paths that remain reachable as "explicitly out of contract, no parity promised" (clause 3) rather than leaving them unlisted. Without the enumeration, "fail-closed" is unverifiable from the contract text.

**F3 — `/health` body contract is ambiguous; parse must fail closed (BLOCKER-adjacent, treat as blocking clarification).** Source distinguishes anonymous `GET /health` from "full health" that computes healthy/degraded/unhealthy. Clause 5 requires rejecting "200 degraded" but does not state that the anonymous endpoint actually carries a `status` field. Specify: missing, unparsable or unrecognised `status` ⇒ `unknown`, never `healthy`; explicit bounded deadline on `health()` (today it skips the ordinary request deadline and returns `healthy: res.ok`); timeout and non-JSON are distinct recorded observations. Do not infer service permissions from any health value (clause 5 already says this — keep it in README).

**F4 — Clause 5 redaction contradicts the acceptance line "preserve exact observations" (BLOCKER).** `GET /api/v1/repos` returns `repo`/`repoClass`/`residency`; existing client error handling plausibly embeds response text in thrown errors, so a malformed-body case could surface repo names or auth material through doctor output. Resolve the contradiction: "exact observations" = status code, outcome class, shape-valid boolean, elapsed-bucket — never bodies. Add a required acceptance item: a malformed/degraded fixture containing a sentinel repo name and a sentinel token must not appear anywhere in doctor output or logs.

**F5 — Known remote-contract defects should be recorded, not patched (IMPROVEMENT).** `client.startTask` mints a fresh idempotency key per attempt (retry-duplicate hazard), and prompt sizing is inconsistent (tool cap 100000 + 12000 instructions vs service `goal` max 8000; no `model`/`agent`/`permission`/`readOnly` fields exist in `StartTaskSchema`). Correct not to fix these here. Record them as prerequisites on issue 241 and keep the "no `startTask` POST" assertion as the only behavioural guarantee.

## Unverified assumptions

- The fixture reproduction is builder-run only; I have not repeated it and treat it as non-deployed evidence.
- That the five files cover every path reaching `client`/adapter/hub — unenumerated (F2).
- Anonymous `/health` body shape and whether it ever reports `degraded` (F3).
- That doctor consumers tolerate a tri-state (`not_run`/unknown) without rendering it as pass; clause 6's "no empty array or zero count" needs a type-level representation in `context.ts`/`doctor.ts`.
- Existing `remote-runtime`/`remote-client` tests do not already assert the fabricated `health:"healthy"`/`policyVerified:true` facts that clause 2 removes; if they do, those edits must be shown as strengthening, not weakening.
- Pinned identities (`c4fa54c…`, `acfcb8b…`), package-scoped AGENTS test command, and that the five saved-session records remain untouched (clause 7).

### openai/gpt-5.6-sol

## Recommendation: ADOPT containment

No concrete architecture blocker is evident from the supplied source excerpts. The proposal is appropriately fail-closed and does not pretend to make the remote backend usable or policy-equivalent.

### Findings

1. **Containment closes both execution entry points — no blocker.**
   Clauses 2–3 block at the runtime composition boundary and again inside the adapter. This is important because `oc_start_session` otherwise reaches workspace capture after `ctx.box()`, while the current adapter starts a task during `POST /session` before the real prompt is known. Keeping `peekBox` undefined and refusing adapter create/prompt independently provides defense in depth.

2. **Use one stable refusal contract everywhere — improvement.**
   For clauses 2–3, the typed error should have one canonical machine-readable code, `policy_unverified`, across runtime methods, adapter routes, and tool error translation. Unsupported `/models`, `/mcp`, and unknown paths must use explicit non-success HTTP statuses, not merely an error-shaped HTTP 200 response. Avoid including repository, prompt, token, or response-body content in refusal details.

3. **Readiness probes must be independently bounded and represented tri-state — improvement.**
   Clause 5 should preserve separate observations for public health and protected catalog access: pass, fail, or not observed/unknown. A health timeout or malformed body must not become an auth failure, and an auth failure must not overwrite a valid health result. Each request needs a deadline; total doctor duration should also remain bounded. Parsing repository objects is necessary for shape validation, but names and bodies must not be retained or surfaced.

4. **Doctor must not reuse local “passed” structures — improvement.**
   Clauses 4 and 6 correctly require bypassing Docker, sign-in, home-token, egress, and lease checks. The returned structure should omit those check results or mark them explicitly unobserved; empty arrays and zero counts would falsely imply execution. Even with healthy service and valid catalog authentication, the final result must remain `verified:false`, reason/code `policy_unverified`.

5. **Acceptance should guard all task-start paths, not just route responses — improvement.**
   The proposed evidence is strong. Instrument the loopback fixture so any `POST /api/v1/tasks`, seed callback, workspace mutation, or saved-record mutation fails the test immediately. The controlled mutation should separately demonstrate detection at the runtime guard and adapter guard. Existing status/result behavior should not be asserted as parity; this patch neither repairs nor authorizes it.

### Unverified assumptions

- The existing runtime/supervisor interfaces can represent unavailable/unverified status without editing files outside the frozen surface.
- `ToolContext` is the composition point used by both `oc_*` and `code_*` aliases, including `delegate_task`.
- No other production caller invokes `remote/client.startTask` directly while bypassing both `ctx.box()` and `remote/api.ts`.
- Existing error translation preserves the typed `policy_unverified` code rather than converting it to a generic success or internal error.
- The configured token resolver can support the read-only catalog probe without creating or refreshing broader grants.

Issue #241 should remain open for a separately approved remote execution contract.

### google/gemini-3.1-pro-preview

**Recommendation: ADOPT**

The proposed fail-closed containment correctly addresses the immediate capability mismatch and authorization bypass without introducing risky, out-of-scope feature logic (like logical session mapping). It identifies the deceptive stubs in the current adapter—specifically the fabricated `policyVerified: true`, the blind 200-OK health check, and the mocked `/mcp` endpoints—and replaces them with accurate, hard-failing boundaries.

### Findings

1. **Context Boundary Severance (Improvement)**
   *Source/Clause:* Rule 2 (`ctx.box` throws `policy_unverified`) and Tool ordering evidence.
   *Analysis:* Placing the throw inside `ctx.box()` correctly intercepts `oc_start_session` and `oc_send` immediately after `refuseBusy` (which safely bypasses because `peekBox` is undefined). This guarantees execution halts *before* `workspaces.open` captures patch data or binds host state, preventing side-effects for a task that cannot be accurately transmitted.

2. **Health Check Fidelity (Improvement)**
   *Source/Clause:* Rule 5 (Validate health body status; 200 degraded is not healthy) vs Evidence (GET /health anonymous, full health computes 'degraded' for failed dependencies with HTTP 200).
   *Analysis:* The current `client.ts` blind-trusts `res.ok` (HTTP 200). The service explicitly returns HTTP 200 for a `degraded` state. By enforcing JSON body inspection, the doctor will no longer falsely report backend readiness when downstream inference or storage dependencies are failing.

3. **Schema and Capability Truncation (Improvement)**
   *Source/Clause:* Rule 3 (Adapter POST /session refuses before client.startTask; unsupported paths return explicit errors).
   *Analysis:* The deployed `StartTaskSchema` strictly refuses (`.strict()`) arbitrary model, agent, and permission fields, meaning the existing adapter was silently dropping user intent to force the request through. Hard-rejecting at the adapter level stops this silent truncation. Removing the faked `/mcp` and `/models` endpoints also prevents the host client from hallucinating that local tools are available remotely.

4. **Authentication vs. Authorization Separation (Improvement)**
   *Source/Clause:* Rule 5 (Authenticated catalog read is not execution authorization) and Rule 6 (Always remote doctor `verified:false`).
   *Analysis:* Successfully fetching `/api/v1/repos` only proves the provided token is valid for catalog reads. Because the remote service schema has no concept of MCP boundaries or strict readonly constraints, passing a read check must not map to `policyVerified: true`. Rule 6 correctly preserves this semantic gap.

### Unverified Assumptions

* **Bridge Error Handling:** The plan assumes that throwing `policy_unverified` from asynchronous runtime initialization functions (like `ctx.box()` or `supervisor.ensure()`) is safely caught by the local MCP bridge’s tool-invocation wrapper, yielding a gracefully formatted MCP error response rather than crashing the local `stdio` process.
* **Idempotency Key Abandonment:** The evidence notes the current `client.ts` generates a random `idempotencyKey` per attempt (`Date.now()/Math.random`), which defeats the purpose of the key. Since this plan completely blocks `client.startTask`, fixing the idempotency generation is safely deferred, assuming no other background polling mechanism attempts to retry these blocked requests.

This containment patch securely isolates the incomplete remote backend. You may proceed to human approval for the implementation.

## Verification and approval state

| AIRUN-058 stage | Observed disposition |
| --- | --- |
| Scope/baseline/layer placement | Recorded and independently reviewed; proposed fit, not implemented proof. |
| Pluggability | Existing seams reused; no new extension framework. |
| ADR/exception interpretation | Open: no exception requested, but runbook Step 6/verification wording is internally inconsistent for non-exception High-risk work. Named owner must disposition before code. |
| Three independent reviews | Complete: 3 usable exact reported-model matches from 3 developer families. |
| Named owner approval / GO | **NO-GO pending Igor's approval of the final contained contract and open procedure dispositions.** No auth-capability fact is inferred from the proposal. |
| Step 9 implementation | Not started; none authorized by this record. |
| Step 10 canonical KB log | This project file holds the full local record under the parent's one-file write limit. The canonical KB audit-log path was not written; no full AIRUN-058 PASS is claimed. Parent must disposition/log through the allowed writer before claiming procedure completion. |
| Rollback | No executable change to restore. Preserve this review record; do not reset unrelated files. |
| Delivery | No merge, deployment, installation, saved-record move, remote task or ARCH-GATE-02 approval. |


## Named owner approval receipt — appended after the frozen review

At 2026-10-25T13:42:59Z the implementer read this record and observed SHA256 `10cad84b4dd47037c7130ed116cbc31014365952d4ab6acd07d47d833754348e` before any executable edit. The coordinating root relayed Igor Jericevich's answer to the exact contract question: **“Approve temporary block (Recommended)”**. This is named GO for this five-source-file containment only. It does not approve usable remote execution, a new grant, a backend rewrite or a different contract. The original frozen text and three reviews above are preserved as the pre-approval record; their pending status is historical, not silently rewritten.

A separate owner answer, “Yes, move the five and test”, is assigned to another operator on the unchanged primary local backend. This implementer does not own or operate that migration. Local testing and this remote source work have separate file/data ownership.

The implementer has asked the root to disposition the literal AIRUN-058 Step 6/6B inconsistency before executable edits. Step 10 logging is due after verification; no complete AIRUN-058 PASS is claimed yet. No code has changed at the time of this appendix.
## Procedure disposition and implementation admission

After the named owner approval above, the root explicitly directed implementation within that contract. AIRUN-058 Step 6 says: “Condition FALSE → skip to Step 7A or Step 7B and record ARCH-ADR = NOT-REQUIRED” when no required architectural constraint conflicts. Step 6B also says: “Standard and High-risk work MUST use Step 6A.” Step 6A is an exception process requiring status `Exception Requested`, expiry and an exception register. There is no standards conflict or requested exception in this containment.

The root's recorded disposition is to apply the conditional Step 6 and the governing architecture standard's exception-only process; the blanket Step 6B sentence is contradictory and inapplicable without an exception. No security or runtime gate is waived. A normal accepted ADR records the chosen contract, alternatives, rollback and exit criteria at `docs/architecture/decisions/ADR-001-remote-delegate-containment.md`, with a README index. It states **no standards exception requested** and **exception register N/A**. No fictitious exception status, row or automatic guard expiry is created. The KB procedure inconsistency will be reported at closeout. This is an explicit interpretation, not a claim of literal unqualified AIRUN-058 PASS.

The five-source-file freeze remains in force. Step 10 logging follows verification. Final-head tests, reviews and nonauthor ARCH-GATE-02 remain required before delivery.
## Reviewed implementation clarifications

The independent code review found that `cli.ts` calls the optional top-level `runtime.synapse.start()` hook. Source `synapse/refresh.ts:115–125` creates a refresh interval and runs an immediate tick. Remote runtime now omits that optional hook, while keeping the existing explicitly invoked context sign-in service. The test runs the same optional CLI startup-hook expressions and asserts no remote refresh hook exists. It does not claim a full spawned CLI test; the CLI's separate dashboard/marker behavior is not part of that assertion.

The root also approved two necessary **text-only** additions to the frozen five behavior files: `src/server.ts` INSTRUCTIONS opening line, and `src/tools/delegate-task.ts` header/description. Their pre-existing promise of remote execution contradicted the containment; the text now states local Docker support and remote `policy_unverified` until a verified replacement contract. No behavior, dependency, schema or other source change is authorized in those two files.

## Verification and delivery checkpoint

Recorded at the observed UTC clock read **2026-10-25T21:34:31Z**. This section updates the current record; it does not rewrite the frozen prebuild review or assign a timestamp to the owner's reply.

The saved implementation was `bfe17f10bdd01d04d862064567211e681ffaaa29`, based on current `origin/dev` `c4fa54c46bfeadd0b9488703161686cb1901b52f` when fetched before verification. Native queued Bun 1.3.14 installed the root's frozen dependencies: 4,695 packages, exit 0. No tracked lockfile or production-source change resulted. The queue reported one lingering compiler helper after the install and released its slot normally; no process or queue policy was changed to clear it.

Package typecheck initially found three test-only errors: two callable fetch fixtures lacked Bun's required `preconnect` member, and the SDK result needed a narrow outer assertion before reading `remote`. The correction adds a real throwing `preconnect` stub and preserves the prior runtime shape check plus required dereferences. No assertion was removed or made optional. Independent Fresh QA read that two-file delta and reported a static PASS. The reviewed working-file SHA-256 values were `CE881E93D2F46B50A013F41E7909C8CC181C6AF2B8688EF689BFCBB9D20F237E` (`test/remote-api.test.ts`) and `5D1DE47667EDFD583B7492BAC0B3A6A17C66F88C93158D127ECA249FFBFE3347` (`test/remote-runtime.test.ts`).

All Bun execution below used the unchanged native work queue from `alterspective/delegate-mcp`, except the root dependency install and root file-scoped lint. Exact commands and terminal output are retained in private logs; file identifiers below allow byte verification.

| Check | Observed result |
| --- | --- |
| Focused remote runtime/client/adapter tests | 39 pass, 0 fail, 238 assertions across three files; exit 0 before and after the type correction |
| Package `bun run typecheck` after correction | Exit 0 |
| Initial full package run | 1,422 pass, 43 skip, 78 fail; exit 1. The output included Windows `sh`-not-found errors. This run is retained as a failure. |
| Full package rerun | 1,500 pass, 43 skip, 0 fail; 6,192 assertions, 1,543 tests across 104 files, 286.67 seconds; exit 0. Git's `usr/bin` and `bin` were prepended only to this queued child PowerShell process's PATH so fixture shell calls could resolve `sh`. No global environment or queue setting was changed. |
| File-scoped oxlint | All 10 changed source/test files examined; 46 warnings, 0 errors; exit 0. This is not a zero-warning claim. |
| Runtime fault control | A temporary workspace-capture attempt before refusal made the selected fixture test fail at the no-capture assertion: `workspace:1` versus `0`; exit 1. Only the fixture's temporary repository was reached. |
| Adapter fault control | A temporary task-request attempt before refusal made the injected-fetch fixture fail at the no-request assertion: `requests:1` versus `0`; exit 1. No network task was submitted. |
| Byte restoration and focused recheck | Both production files restored from raw byte backups; Git diff empty for each. Restored focused run: 39 pass, 0 fail, 238 assertions; exit 0. |

The restored production-file SHA-256 values are `D960A7219DDB2E483CBFFA6AD10FD4CD4599EE11D0FFC536DFA2C218FAC8E67D` (`src/runtime.ts`) and `93F0E5FCF3955ED9170C3D5901A1797529D323D60BEE2334C8950D9F7C166E3E` (`src/remote/api.ts`). Neither mutation is part of the delivery diff.

| Private terminal log | SHA-256 |
| --- | --- |
| `package-tests-gitsh-fixed.log` | `2ECF3A40E098721ED45536302C9BA6872EAFEA17CDABE76ED0A6D38A2F394886` |
| `runtime-fault-tests.log` | `9D29AF438938FC1E0C0F03F00670CBCB7984B59229B02F7BE648A40CE3FCE88A` |
| `adapter-fault-tests.log` | `08EF569100532DB23D430345CFB7814B5848D60127C1B8A7509C35B240949582` |
| `focused-tests-restored.log` | `8F7878C87C1C10EC8BF1E87A449C2585613B61B479A0F71D90CD23A36E2AC6DA` |

At this checkpoint, normal pre-push root typecheck, current-head hosted Linux checks, final full-source review, Fresh QA, nonauthor `ARCH-GATE-02`, PR reviews and merge remain pending. The 43 explicit skips are not passes. These are fixture/package results; no live remote task, global installation, app deployment, shared-runtime operation or saved-record move was performed by this source-verification task. Remote doctor remains `verified:false`, and the usable remote replacement contract remains open under #241.
