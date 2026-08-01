## 1. Decision: **NO-GO as stated**

Option B is directionally reasonable, but the plan currently treats prompt text as a security boundary, assumes unverified OpenCode/MCP auth behavior, and lacks controls preventing local or client data from being sent to CAS.

Proceed only after the blocker/high-severity items below are incorporated and demonstrated in a staging acceptance test. This can remain a `.opencode/`-focused implementation; it does not require TaskTool transport or CAS repository changes.

---

## 2. Critical findings

### F-1 — Prompt routing is not an enforcement boundary  
**Severity: Blocker**

A system-prompt routing table can influence model behavior, but cannot guarantee that:

- source code remains local;
- client data is not sent to CAS;
- only approved CAS agents/templates are selected;
- CAS responses cannot induce further tool use;
- `cas_resolve_tool_call` is not used to approve privileged downstream actions.

“Code → local” in a prompt is not equivalent to a data egress policy. The model can misroute ambiguous content, include code in business-persona requests, or follow prompt injection embedded in repository files, RAG output, or CAS responses.

**Failure mode:** A user asks for a matter audit and includes source snippets or credentials. The façade sends the whole context to CAS despite the intended routing guidance.

---

### F-2 — The proposed CAS tool allowlist is too broad  
**Severity: Blocker**

“Tools only MCP `cas_*`” still exposes potentially dangerous operations:

- `cas_delegate` may select broad-capability agents.
- `cas_start_run` may initiate workflows with downstream tools.
- `cas_resolve_tool_call` may approve a pending action.
- list operations may expose agent/template metadata not intended for all users.
- session/run operations may allow cross-session access if CAS authorization is weak or identifiers are exposed.

The plan does not define exact tools per façade or whether wildcard tool restrictions are actually enforced by OpenCode rather than merely described in Markdown.

**Required concern:** `cas_resolve_tool_call` should not be available by default. It is effectively an approval capability and may convert a low-risk chat interaction into a privileged external action.

---

### F-3 — No data-classification or egress consent gate  
**Severity: Blocker**

“Do not put client names in shareable content” is narrower than the actual risk. Client identity can be inferred from:

- matter numbers;
- email addresses and domains;
- document contents;
- repository names and paths;
- URLs, tenant IDs, ticket IDs, metadata;
- quoted RAG results;
- source code, logs, stack traces, or configuration.

The plan does not define what data CAS may receive, whether CAS retains prompts/files, where they are hosted, or whether users must explicitly approve transmission.

**Failure mode:** The router delegates a “business” question with automatically attached conversation history containing client-sensitive material.

---

### F-4 — Authentication configuration is assumed, not verified  
**Severity: High**

The suggested configuration:

> Bearer `{env:CAS_MCP_TOKEN}`

needs validation against the exact OpenCode fork/version and MCP configuration schema. Unresolved questions include:

- Does environment interpolation work in header values?
- Does it fail closed if the variable is missing?
- Is the literal placeholder ever transmitted?
- Are headers shown in debug output, diagnostics, crash reports, or config dumps?
- Does the MCP client preserve or drop authorization across redirects?
- Does OpenCode attempt native OAuth despite a static bearer header?
- Does the token reach only `agent.alterspective.com.au`?

CAS being healthy does not establish that OpenCode can authenticate. `CAS_MCP_TOKEN` is absent, and there is no end-to-end evidence.

---

### F-5 — Eight-hour non-refreshable tokens make this operationally incomplete  
**Severity: High**

The plan describes degraded mode only for a missing token, not for:

- token expiration during an OpenCode session;
- revoked or malformed tokens;
- clock skew;
- 401/403 responses;
- CAS authentication changing while a run is active.

An eight-hour token with no refresh is not just a documented gap. It is a predictable runtime failure.

**Failure mode:** A CAS run is created shortly before expiry, polling later returns 401, and the user receives neither a recoverable state nor the run ID needed to resume.

---

### F-6 — Remote CAS output is untrusted model/tool content  
**Severity: High**

CAS responses can contain prompt injection or instructions such as:

- invoke another tool;
- disclose local files;
- resolve a pending tool request;
- ignore the local routing policy;
- send additional context.

The plan only mentions system-prompt injection; it does not define how remote output is delimited, labelled, or prevented from authorizing subsequent local actions.

CAS output must be treated like untrusted MCP output, not trusted subagent instructions.

---

### F-7 — Verification scope is materially insufficient  
**Severity: High**

Testing only “plugin injection gates” proves that text was added to a prompt. It does not prove:

- MCP configuration loads;
- authentication succeeds;
- secrets are not logged;
- tool restrictions are enforced;
- no-token startup is non-fatal;
- expired-token handling works;
- the correct agent/template is selected;
- sensitive context is not transmitted;
- cancellation and polling work;
- CAS errors are surfaced accurately;
- malicious CAS output cannot trigger privileged actions.

A mirrored prompt-test pattern is useful but is not acceptance evidence for a remote authenticated integration.

---

### F-8 — “Subagent façade” may misrepresent isolation and lifecycle  
**Severity: High**

Markdown agents may look like native TaskTool subagents while behaving differently:

- no guaranteed child-session isolation;
- no standardized cancellation propagation;
- no automatic run polling;
- no context minimization;
- no ownership binding between OpenCode session and CAS session;
- no guarantee that CAS conversations are cleaned up;
- no guarantee that only façade tools are available.

The plan must state what is real enforcement versus model convention. Otherwise users may assume local-subagent privacy and lifecycle semantics that do not exist.

---

### F-9 — Session/run authorization and identifier handling are unspecified  
**Severity: High**

CAS session and run IDs are access-relevant data. The plan does not verify:

- whether IDs are scoped to the authenticated principal;
- whether one user can query or cancel another user’s run;
- whether IDs appear in logs or shareable transcripts;
- how abandoned runs are handled;
- whether retries can create duplicate runs;
- whether a run can outlive the originating local session.

“Deep TUI” can remain out of scope, but correct ownership, status, cancellation, and recovery cannot.

---

### F-10 — Local code ownership does not imply local code confidentiality  
**Severity: High**

The goal says code ownership remains local, but the design does not prohibit code transfer to CAS. Ownership, storage location, and disclosure are separate concerns.

If CAS must not receive source code, diffs, repository metadata, or file contents, that needs an enforceable policy or an explicit user confirmation step. A routing sentence is inadequate.

---

### F-11 — Repository-scope constraints are internally ambiguous  
**Severity: Medium**

The fork policy says “prefer `.opencode/` only,” while the plan also adds:

- `docs/implementation/current/...`
- tests that may require an existing package test harness or changes outside `.opencode/`.

This may be acceptable, but the allowed change envelope should be explicit. Otherwise the implementation either violates the policy or produces tests that are not integrated into CI.

---

### F-12 — MCP failure semantics are not designed  
**Severity: Medium**

The plan does not specify:

- initialize/protocol-version compatibility;
- request and polling timeouts;
- retry limits and backoff;
- retry safety/idempotency for session/run creation;
- maximum response sizes;
- rate-limit handling;
- cancellation behavior;
- structured handling for MCP errors versus CAS run failures;
- whether streaming is expected.

Blind retry of `cas_start_run` could create duplicate work and duplicate external side effects.

---

## 3. Must-fix plan changes

### A. Add a hard egress and approval policy

Define, in implementation and documentation, what may be sent to CAS.

At minimum:

1. Do not automatically forward full conversation history.
2. Do not automatically include repository files, diffs, tool outputs, RAG results, environment values, or system prompts.
3. Construct a minimal CAS request from an explicit user-authored payload.
4. Require confirmation before first external delegation in a session, showing:
   - destination: CAS;
   - selected approved agent/template;
   - a preview or summary of the data being sent;
   - warning that it leaves the local OpenCode execution boundary.
5. Refuse or require stronger confirmation when likely secrets, credentials, client identifiers, source code, or matter data are detected.
6. Make clear that detection is defense in depth, not a guarantee.

If OpenCode’s `.opencode/` plugin API cannot enforce this, narrow the wave to explicit user-invoked CAS façades and remove automatic model routing.

---

### B. Replace `cas_*` wildcard access with exact per-agent allowlists

Proposed minimum:

| Façade | Allowed by default |
|---|---|
| `cas-drafter` | session creation, send message, start run, get run, cancel own run |
| `cas-matter-audit` | same, but only an approved audit agent/template |
| `cas-general` | same, with an explicit approved agent list |
|
