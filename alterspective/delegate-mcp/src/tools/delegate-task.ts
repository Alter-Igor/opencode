// delegate_task (FEAT-CD-001): 1-step autonomous task delegation.
// Orchestrates start -> send -> wait (long poll) -> collect -> result in a single call.
// Works across both local Docker and remote svc-coding-agent cloud microVM backends.
import { z } from "zod"
import { DelegateError } from "../shared/errors.ts"
import type { ToolContext } from "./context.ts"
import { delegationProfileSchema } from "./core-session.ts"
import { defineTool } from "./define.ts"
import { ok, untrusted } from "./shape.ts"
import { startSessionTool } from "./sessions.ts"
import { closeSessionTool } from "./close-session.ts"
import { sendTool, MAX_MESSAGE_CHARS } from "./send.ts"
import { waitTool } from "./wait.ts"
import { collectTool } from "./collect.ts"
import { resultTool } from "./result.ts"

/** #252: settled states that mean the task did not complete (never "timed out, still running"). */
const FAILED_STATES = new Set(["error", "aborted", "not_started", "not_found"])

export const delegateTaskInput = {
  directory: z
    .string()
    .min(1)
    .max(1024)
    .describe("The target repository directory on the host (e.g. C:\\GitHub\\my-repo)."),
  prompt: z
    .string()
    .min(1)
    .max(MAX_MESSAGE_CHARS)
    .describe("Task instructions or prompt for the coding agent to execute."),
  engine: z
    .enum(["auto", "deepseek", "opencode"])
    .optional()
    .describe("Execution engine: 'auto' (default) or 'opencode' both run the sandbox's default OpenCode agent. 'deepseek' is refused: there is no DeepSeek harness; pass a DeepSeek model as `model` instead."),
  model: z
    .string()
    .optional()
    .describe("Optional explicit Synapse model override (e.g. synapse/deepseek-v4-flash). Takes precedence over engine default."),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(1_800_000)
    .optional()
    .describe("Maximum execution timeout in milliseconds (default: 300,000 = 5m, max: 1,800,000 = 30m)."),
  delegationProfile: delegationProfileSchema
    .optional()
    .describe("Optional per-task delegation profile (#124) narrowing Keystone /mcp/dynamic tool reach for this task. Can only narrow the owner's profile, never widen it."),
}

export const delegateTaskTool = defineTool({
  name: "delegate_task",
  title: "Delegate a complete coding task in one step",
  description:
    "Autonomous 1-step delegation: starts a session on your repository, sends the task prompt, waits for completion, " +
    "and collects the finished work into local branch delegate/<key>. Engine 'auto' or 'opencode' runs the sandbox's default " +
    "agent across local Docker and cloud backends; 'deepseek' is refused (pass a DeepSeek model as `model`).",
  input: delegateTaskInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const startedAt = Date.now()
    const timeoutMs = args.timeoutMs ?? 300_000

    // #252: `engine` never names an agent. The box's agents are build/explore/general/plan;
    // sending "opencode" or "deepseek" made the prompt fail with "Agent not found". `auto` and
    // `opencode` run the box's default agent. There is no DeepSeek harness, so `deepseek` is
    // refused before a session (and a host branch) is created; pick a deepseek model with `model`.
    if (args.engine === "deepseek")
      throw new DelegateError(
        "invalid_input",
        "There is no DeepSeek engine in this sandbox.",
        "Leave engine unset (or 'auto') and pass a DeepSeek model as `model`, e.g. one from code_list_models.",
      )

    // 1. Start Session (allowShared is disabled when a per-task delegationProfile is set)
    const startRes = await startSessionTool.run(
      {
        directory: args.directory,
        allowShared: args.delegationProfile === undefined,
        model: args.model,
        ...(args.delegationProfile ? { delegationProfile: args.delegationProfile } : {}),
      },
      ctx,
      correlationId,
    )

    const sessionID = startRes.structuredContent?.sessionID as string
    const branch = startRes.structuredContent?.branch as string
    const base = startRes.structuredContent?.base as string
    const hostRepo = startRes.structuredContent?.hostRepo as string

    // 2. Send Prompt (#263: clean up on confirmed rejection; retain session on ambiguous transport failure)
    let sendRes: Awaited<ReturnType<typeof sendTool.run>>
    try {
      sendRes = await sendTool.run(
        {
          sessionID,
          message: args.prompt,
          model: args.model,
        },
        ctx,
        correlationId,
      )
    } catch (error) {
      return await handleFailedSend(error, sessionID, ctx, correlationId)
    }

    let cursor = sendRes.structuredContent?.cursor as string | undefined

    // 3. Polling Wait Loop with chunked timeouts
    let finalState = "busy"
    let lastViews: Array<{ sessionID: string; state: string; lastError?: string; detail?: string }> = []
    // The state event that set finalState when the wait returned no view (its summary is bridge words only).
    let stateFromEvent: { summary?: string; code?: string } | undefined

    while (Date.now() - startedAt < timeoutMs) {
      const elapsed = Date.now() - startedAt
      const remainingSec = Math.max(5, Math.min(60, Math.floor((timeoutMs - elapsed) / 1000)))

      const waitRes = await waitTool.run(
        {
          sessionIDs: [sessionID],
          cursor,
          timeoutSec: remainingSec,
        },
        ctx,
        correlationId,
      )

      if (waitRes.structuredContent?.next) {
        cursor = waitRes.structuredContent.next as string
      }

      const views = (waitRes.structuredContent?.views ?? []) as typeof lastViews
      const events = (waitRes.structuredContent?.events ?? []) as Array<{ sessionID?: string; state?: string; summary?: string; code?: string }>

      if (views.length > 0 && views[0]) {
        lastViews = views
        stateFromEvent = undefined
        const matched = views.find((v) => v.sessionID === sessionID) ?? views[0]
        finalState = matched.state
      } else {
        const stateEvent = [...events].reverse().find((e) => e.sessionID === sessionID && e.state)
        if (stateEvent?.state) {
          finalState = stateEvent.state
          stateFromEvent = stateEvent
        }
      }

      if (finalState === "idle" || finalState === "needs_input" || FAILED_STATES.has(finalState)) {
        break
      }

      if (!waitRes.structuredContent?.still_running) {
        break
      }
    }

    // 4. Handle non-idle completion states
    if (finalState === "needs_input") {
      return ok(
        `Task suspended: session ${sessionID} requires input or approval. Call code_pending { sessionID: "${sessionID}" } to view requests, and code_answer to respond.`,
        {
          status: "needs_input",
          sessionID,
          branch,
          durationMs: Date.now() - startedAt,
          advice: `Call code_pending { sessionID: "${sessionID}" } to inspect questions or approvals, and code_answer { sessionID: "${sessionID}" } to reply.`,
        },
      )
    }

    if (FAILED_STATES.has(finalState)) {
      // #252: a view older than the state event that ended the wait describes an earlier state.
      const matched = stateFromEvent ? undefined : lastViews.find((v) => v.sessionID === sessionID)
      const fromEvent = stateFromEvent?.code ?? stateFromEvent?.summary
      const detail = matched?.lastError ?? matched?.detail ?? (fromEvent || "Task failed")
      return ok(`Task ended in state '${finalState}': ${detail}`, {
        status: "failed",
        sessionID,
        branch,
        durationMs: Date.now() - startedAt,
        error: detail,
      })
    }

    if (finalState !== "idle") {
      // Timed out while still active
      return ok(
        `Task timed out after ${Math.round((Date.now() - startedAt) / 1000)}s while still working. The session remains active in the background.`,
        {
          status: "timed_out",
          sessionID,
          branch,
          durationMs: Date.now() - startedAt,
          stillRunning: true,
          cursor,
          advice: `Use code_wait { sessionIDs: ["${sessionID}"], cursor: "${cursor}" } to continue waiting, or code_abort { sessionID: "${sessionID}" } to cancel.`,
        },
      )
    }

    // 5. Completed: Collect branch into host repository
    const collectRes = await collectTool.run({ sessionID }, ctx, correlationId)
    const commits = (collectRes.structuredContent?.commits as number) ?? 0

    // Authoritative host git diff for changed files (with strict validation against option injection)
    let changedFiles: string[] = []
    if (base && branch && /^[0-9a-f]{7,40}$/.test(base) && /^delegate\/[a-z0-9_-]+$/.test(branch)) {
      const diffRes = await ctx.hostExec(["git", "-C", hostRepo, "diff", "--name-only", `${base}..${branch}`, "--"])
      if (diffRes.code === 0) {
        changedFiles = diffRes.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      }
    }

    // Extract summary of work from last assistant reply
    let summaryText = ""
    try {
      const resultRes = await resultTool.run({ sessionID, messages: 1 }, ctx, correlationId)
      const replies = (resultRes.structuredContent?.replies as Array<{ untrusted?: { text?: string } }>) ?? []
      summaryText = replies[0]?.untrusted?.text ?? ""
    } catch {
      // Result retrieval is advisory; collection already succeeded
    }

    const summary = `Task completed on branch ${branch} (${changedFiles.length} file(s) changed, ${commits} commit(s)).`
    return ok(summary, {
      status: "completed",
      sessionID,
      branch,
      commits,
      changedFiles,
      filesCount: changedFiles.length,
      summaryOfWork: untrusted(summaryText),
      durationMs: Date.now() - startedAt,
      advice: `Changes collected into local branch ${branch}. Review with 'git diff ${base}..${branch}'. When satisfied, merge into your working branch, then clean up with code_close_session { sessionID: "${sessionID}", deleteBranch: true }.`,
    })
  },
})

/** True only when `sendTool.run` failed before the prompt was sent or with an explicit HTTP non-2xx rejection. */
function isConfirmedSendRejection(error: unknown): error is DelegateError {
  if (!(error instanceof DelegateError)) return false
  if (error.code === "server_down") return false
  if (error.code === "upstream_error") return /^HTTP \d+$/.test(error.detail ?? "")
  return true
}

/**
 * #263: On confirmed send rejection, close and discard the newly created session (reporting any
 * incomplete cleanup alongside `sessionID` and `oc_list_sessions`). On ambiguous transport or
 * response-reading errors, retain the session and surface `sessionID` for recovery.
 */
async function handleFailedSend(error: unknown, sessionID: string | undefined, ctx: ToolContext, correlationId: string): Promise<never> {
  if (!sessionID) throw error
  if (!isConfirmedSendRejection(error)) {
    const baseErr =
      error instanceof DelegateError
        ? error
        : new DelegateError("upstream_error", "The prompt request failed while reading the response.", "Check oc_status, then retry.", error instanceof Error ? error.message : String(error))
    throw new DelegateError(
      baseErr.code,
      `${baseErr.message} Session ${sessionID} was retained because prompt acceptance is uncertain.`,
      `${baseErr.action} Inspect or recover session ${sessionID} with oc_status or oc_list_sessions.`,
      baseErr.detail ? `${baseErr.detail} (sessionID=${sessionID} retained)` : `sessionID=${sessionID} retained`,
    )
  }

  let cleanupStatus: string | undefined
  try {
    const closeRes = await closeSessionTool.run({ sessionID, abort: true, discardWork: true, deleteBranch: true }, ctx, correlationId)
    const sc = closeRes.structuredContent ?? {}
    if (sc.closed !== true) {
      cleanupStatus = `closed=false (session=${String(sc.session ?? "unknown")}, clone=${String(sc.clone ?? "unknown")}, branch=${String(sc.branch ?? "unknown")}, record=${String(sc.record ?? "unknown")})`
    }
  } catch (cleanupErr) {
    cleanupStatus = cleanupErr instanceof DelegateError ? `${cleanupErr.code}: ${cleanupErr.message}` : cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
  }

  if (!cleanupStatus) throw error
  throw new DelegateError(
    error.code,
    `${error.message} Cleanup of session ${sessionID} was incomplete (${cleanupStatus}).`,
    `${error.action} Inspect session ${sessionID} with oc_list_sessions and retry oc_close_session { sessionID: "${sessionID}", abort: true, discardWork: true, deleteBranch: true }.`,
    error.detail ? `${error.detail}; cleanup: ${cleanupStatus}` : `cleanup: ${cleanupStatus}`,
  )
}
