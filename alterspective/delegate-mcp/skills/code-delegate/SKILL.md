---
name: code-delegate
description: "Delegates coding work to autonomous coding agents in the local Docker sandbox via the code-delegate MCP server. This file is a pointer: the authoritative skill is OPS-008-00 in the Alterspective-Intelligence KB. Read it before delegating."
argument-hint: "[repo directory] [task prompt]"
disable-model-invocation: true
---

# ROLE: Delegating Agent (Code Delegate)

**Owner:** Igor Jericevich
**Last Updated:** 2026-11-02
**Status:** Pointer — do not extend this file. Edit the KB skill instead.

## Authoritative skill

The full skill lives in the Alterspective-Intelligence KB:

- `Skills/Operating/OPS-008-00-delegate-to-opencode.md` (`OPS-008-00`, skill v0.2.0, last modified 2026-11-01)

Fetch it with `rag_get_articles` and follow it. This file exists only so clients that load
skills from this folder never fall back to the stale pre-2026-11 content that used to sit here.

## Corrections vs the old copy (2026-10-19)

The previous version of this file was wrong. If you still see those claims anywhere, treat them
as false:

1. **Remote backend is a stub.** `OPENCODE_DELEGATE_BACKEND=remote` / `SVC_CODING_AGENT_URL`
   is not implemented (opencode #242, #254). Do not route work to a remote `svc-coding-agent`
   engine. For repo-scale cloud coding use `svc-coding-agent` via Keystone dynamic MCP
   (KB-AI-016 § Coding agent via Keystone dynamic MCP) — that is a different path from this MCP
   server.
2. **No engine selection.** There is no `engine: 'auto' | 'deepseek' | 'opencode'` argument in
   the current tool contract. Models are Synapse-only: leave `model` unset (`synapse/auto`) or
   pick from `code_list_models` / `oc_list_models`.
3. **The granular path is real.** Besides the fast path `delegate_task` (`code_delegate_task`),
   the granular path is `code_start_session` → `code_send` → `code_wait` → `code_pending` /
   `code_answer` → `code_result` → `code_collect` → `oc_close_session` → `oc_cleanup`
   (`oc_*` names are the originals; `code_*` covers the rest). Use the granular path when you need to
   approve gated Keystone tool calls mid-task.
4. **Approvals and safety model.** Pending approvals are answered `once` or `reject` — never
   `always`. Every approval's tool and arguments are read before answering. `code_collect`
   returns `hostExecutableChanges`; review every flagged file. The caller (you) runs the tests,
   typecheck and lint, merges through a reviewed PR, then closes the session and runs
   `code_cleanup`. Never leave sessions open.
5. **Check the bridge first.** Run `code_doctor` / `oc_doctor` once per session before the
   first start; `verified: true` means go, anything else is fixed per OPS-008-00 § 9 first.

## When to delegate (short form)

Only when all four hold: the task is small and clear with a known "done"; you can review the
diff and run the tests yourself; it needs no secret or vault value (the box holds none — but
with the `dynamic` connection it can call your Keystone tools as you, so choose that set for
the job); and the repo is trusted with no client data. Anything else: do it yourself.
OPS-008-00 § 1 has the full table and the do-not-delegate list.
