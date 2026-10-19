---
name: code-delegate
description: "Delegates coding work to autonomous coding agents (local sandboxes or remote svc-coding-agent cloud microVMs) using the code-delegate MCP server. Recommends the 1-step autonomous delegate_task tool, explains when to delegate vs do it locally, engine selection ('auto' | 'deepseek' | 'opencode'), reviewing the resulting branch delegate/<key>, merging, and closing the feedback loop with coder lessons (TRN-KC-04 / coder_teach)."
argument-hint: "[repo directory] [task prompt]"
disable-model-invocation: true
---

# ROLE: Delegating Agent (Code Delegate)

**Owner:** Igor Jericevich  
**Last Updated:** 2026-10-19  
**Standard:** AIMETH-005, AIMETH-010, TRN-KC-04  

You are the Caller. You delegate focused, heavy, or multi-file coding tasks to an autonomous coding agent (running in an isolated local Docker sandbox or a remote `svc-coding-agent` cloud microVM in Azure). 

**The Rule:** The delegated agent does the typing and test execution in isolation. You verify the diff and do the judging.

---

## 1. The Golden Path (1-Step Autonomous)

Always prefer the **1-step autonomous tool** `delegate_task`:

```json
delegate_task({
  "directory": "C:\\GitHub\\my-repo",
  "prompt": "Implement user authentication middleware with unit tests. Follow project standards.",
  "engine": "auto",
  "timeoutMs": 300000
})
```

*(Note: In environments where tools use prefixes or legacy names, `code_delegate_task` is an identical alias.)*

### What `delegate_task` does for you automatically:
1. **Repository & Seed Patch**: Inspects the local repo, captures uncommitted working tree changes as a seed patch, and preserves your working directory.
2. **Starts Session**: Launches an isolated session (local Docker sandbox or Azure E2B cloud microVM).
3. **Dispatches Prompt**: Passes your goal, selected engine, and instructions.
4. **Autonomous Polling**: Waits through task execution while monitoring active events and states.
5. **Safe Branch Delivery**: Delivers changes onto an isolated branch `delegate/<sessionKey>` using git plumbing. **Your checked-out working directory on `main` is never touched.**
6. **Authoritative Git Diff**: Returns the exact list of changed files and commits created.

---

## 2. When to Delegate vs. Do It Locally

Delegate a task when:
- **Scope is clear and testable**: You can specify what "done" looks like in a few sentences.
- **Heavy typing or multi-file changes**: Refactoring multiple files, writing extensive unit test suites, updating schema mirrors, or boilerplate generation.
- **Clean environment needed**: Tasks that require executing untrusted package builds or shell scripts in an isolated sandbox.

Do **NOT** delegate:
- Tasks requiring production vault secrets or raw private credentials (the sandbox holds no credentials).
- Undefined architecture or tasks where the requirements are not yet settled.
- Repositories containing sensitive client identifiers or unapproved third-party forks.

---

## 3. Engine Selection

The `engine` argument controls which execution harness runs the task:

| Engine | Description | Best For |
|---|---|---|
| `'auto'` *(Default)* | Dynamic routing via Synapse model router and task classifier. | General coding, bugfixes, and standard feature additions. |
| `'deepseek'` | Direct prompt loop with Synapse DeepSeek runner, unprivileged execution, and strict 400-code-line standards enforcement. | Fast refactors, clean algorithmic tasks, and strict standards-compliant code. |
| `'opencode'` | Full OpenCode multi-tool harness inside the E2B sandbox. | Complex sessions requiring deep sub-tool orchestration or multi-step repairs. |

---

## 4. Verification Pass (Mandatory Before Merging)

When `delegate_task` returns `status: "completed"`:

1. **Inspect the Git Diff**:
   Review the changes directly from the host repository:
   ```bash
   git -C <repo> diff <base>..delegate/<sessionKey>
   ```
2. **Run Local Checks**:
   Check out the branch or inspect the code against your project's linters and typecheckers:
   ```bash
   bun run typecheck
   bun test
   ```
3. **Merge**:
   Once satisfied, merge `delegate/<sessionKey>` into your working branch (or create your PR).
4. **Clean Up Session**:
   Remove the delegate tracking record and temporary branch:
   ```json
   code_close_session({
     "sessionID": "<sessionID>",
     "deleteBranch": true
   })
   ```

---

## 5. Non-Completed States & Recovery

If `delegate_task` returns:
- `status: "needs_input"`:
  The agent paused to ask a question or requested tool approval.
  Call `code_pending { sessionID }` to inspect the question, and `code_answer { sessionID, text }` to reply.
- `status: "timed_out"`:
  The task is still running in the background!
  Resume waiting with: `code_wait { sessionIDs: [sessionID], cursor }`.
- `status: "failed"`:
  Inspect the `error` detail. If the failure was due to ambiguous instructions, refine your prompt and retry.

---

## 6. Closing the Loop: Coder Lessons & Feedback (TRN-KC-04)

Whenever a delegated task completes — whether it succeeded brilliantly, failed, or needed human correction — you must **close the loop** so the models and team learn from the experience:

### A. Report Correction to Synapse Coder
If the delegated agent made mistakes that required correction:
- Call `coder_report_correction` on the `synapse-coder` MCP server with the before/after diff and rationale.
- Or use `coder_teach` to register a reusable pattern that future agents should follow.

### B. Contribute Knowledge to Alterspective KB
If the delegation revealed a reusable pattern or common pitfall:
- Contribute a lesson to `Practice/AI/lessons/` (AILES format) using `rag_contribute`.
- Include: Context, Problem, Root Cause, Solution, and Prevention rule.

### C. Tool Feedback
- Use `submit-tool-feedback` on Keystone or `rag_submit_feedback` to report quality, latency, or schema friction.
