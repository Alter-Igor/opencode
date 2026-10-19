// delegate_task (FEAT-CD-001): 1-step autonomous task delegation.
// Orchestrates start -> send -> wait (long poll) -> collect -> result in a single call.
// Works across both local Docker and remote svc-coding-agent cloud microVM backends.
import { z } from "zod"
import { defineTool } from "./define.ts"
import { ok, untrusted } from "./shape.ts"
import { startSessionTool } from "./sessions.ts"
import { sendTool, MAX_MESSAGE_CHARS } from "./send.ts"
import { waitTool } from "./wait.ts"
import { collectTool } from "./collect.ts"
import { resultTool } from "./result.ts"

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
    .describe("Execution engine: 'auto' (default model router), 'deepseek' (DeepSeek harness), or 'opencode' (OpenCode agent). Default: 'auto'."),
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
}

export const delegateTaskTool = defineTool({
  name: "delegate_task",
  title: "Delegate a complete coding task in one step",
  description:
    "Autonomous 1-step delegation: starts a session on your repository, sends the task prompt, waits for completion, " +
    "and collects the finished work into local branch delegate/<key>. Supports 'auto', 'deepseek', or 'opencode' engines " +
    "across local Docker and cloud backends.",
  input: delegateTaskInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const startedAt = Date.now()
    const timeoutMs = args.timeoutMs ?? 300_000

    // Resolve engine to agent/model parameters
    let agent: string | undefined
    if (args.engine === "deepseek") {
      agent = "deepseek"
    } else if (args.engine === "opencode") {
      agent = "opencode"
    }

    // 1. Start Session (allowShared: true to avoid blocking on concurrent runs)
    const startRes = await startSessionTool.run(
      {
        directory: args.directory,
        allowShared: true,
        agent,
        model: args.model,
      },
      ctx,
      correlationId,
    )

    const sessionID = startRes.structuredContent?.sessionID as string
    const branch = startRes.structuredContent?.branch as string
    const base = startRes.structuredContent?.base as string
    const hostRepo = startRes.structuredContent?.hostRepo as string

    // 2. Send Prompt
    const sendRes = await sendTool.run(
      {
        sessionID,
        message: args.prompt,
        agent,
        model: args.model,
      },
      ctx,
      correlationId,
    )

    let cursor = sendRes.structuredContent?.cursor as string | undefined

    // 3. Polling Wait Loop with chunked timeouts
    let finalState = "busy"
    let lastViews: Array<{ sessionID: string; state: string; lastError?: string; detail?: string }> = []

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
      const events = (waitRes.structuredContent?.events ?? []) as Array<{ sessionID?: string; state?: string }>

      if (views.length > 0 && views[0]) {
        lastViews = views
        const matched = views.find((v) => v.sessionID === sessionID) ?? views[0]
        finalState = matched.state
      } else {
        const stateEvent = [...events].reverse().find((e) => e.sessionID === sessionID && e.state)
        if (stateEvent?.state) {
          finalState = stateEvent.state
        }
      }

      if (finalState === "idle" || finalState === "needs_input" || finalState === "error" || finalState === "aborted") {
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

    if (finalState === "error" || finalState === "aborted") {
      const matched = lastViews.find((v) => v.sessionID === sessionID)
      const detail = matched?.lastError ?? matched?.detail ?? "Task failed"
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
