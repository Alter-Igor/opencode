// oc_land (#147): one host-side call to land a task (collect, identity, verify, push, open PR).
import { z } from "zod"
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { ownSession, sessionIdSchema } from "./core-session.ts"
import { defineTool } from "./define.ts"
import { ok, untrusted } from "./shape.ts"
import { parseCommand } from "./verify.ts"

export const landTool = defineTool({
  name: "oc_land",
  title: "Land a delegated task",
  description:
    "Complete a delegated task on the host in one tool call: fast-forward the collected branch into the host worktree, re-author the commit with caller identity and a Co-Authored-By Synapse trailer, run allowlisted verify commands, push to origin, and open a pull request. Stops and reports the failed step if any check fails.",
  input: {
    sessionID: sessionIdSchema,
    worktree: z.string().min(1).max(500).describe("Host repository or worktree directory to land the changes into."),
    branch: z.string().min(1).max(128).describe("Target branch name on the host repository (e.g. 'feature-123')."),
    verify: z.array(z.string().min(1).max(1000)).max(20).optional().describe("Allowlisted test/verification commands to run before push (e.g. ['bun test'])."),
    push: z.boolean().optional().describe("Whether to push to origin after verification. Default true."),
    pr: z
      .object({
        title: z.string().min(1).max(256),
        body: z.string().max(65536).optional(),
        bodyFile: z.string().max(500).optional(),
        base: z.string().min(1).max(128).optional().describe("Base branch for the pull request (default 'dev')."),
      })
      .optional()
      .describe("If provided, opens a GitHub pull request using the gh CLI."),
    author: z
      .object({
        name: z.string().min(1).max(128).optional(),
        email: z.string().min(1).max(128).optional(),
      })
      .optional()
      .describe("Git author name and email. If omitted, uses host git configuration."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    let step = "collect"
    try {
      const box = await ctx.box()
      const { record } = await ownSession(ctx, box, args.sessionID, correlationId)

      // Step 1: Collect session's commits into the host repository
      step = "collect"
      await ctx.workspaces.collect({ sessionKey: record.sessionKey, hostRepo: record.hostRepo, boxPath: record.boxPath, branch: record.branch }, { correlationId })

      // Step 2: Validate worktree
      step = "worktree"
      const targetDir = await ctx.workspaces.resolveRepo(args.worktree)
      const statusRes = await ctx.hostExec(["git", "-C", targetDir, "status", "--porcelain"])
      if (statusRes.stdout.trim().length > 0) {
        throw new DelegateError("directory_busy", "The target worktree has uncommitted files.", "Commit or stash changes before landing.", statusRes.stdout.trim())
      }

      // Step 3: Checkout or merge into target branch
      step = "merge"
      const currentBranch = (await ctx.hostExec(["git", "-C", targetDir, "branch", "--show-current"])).stdout.trim()
      if (currentBranch !== args.branch) {
        const checkoutRes = await ctx.hostExec(["git", "-C", targetDir, "checkout", args.branch])
        if (checkoutRes.code !== 0) {
          throw new DelegateError("upstream_error", `Could not checkout branch ${args.branch} in worktree.`, "Ensure the branch exists or create it first.", checkoutRes.stderr.trim())
        }
      }
      const mergeRes = await ctx.hostExec(["git", "-C", targetDir, "merge", "--ff-only", `delegate/${record.sessionKey}`])
      if (mergeRes.code !== 0) {
        throw new DelegateError("branch_diverged", `Could not fast-forward branch ${args.branch} to delegate/${record.sessionKey}.`, "Resolve branch divergence or merge manually.", mergeRes.stderr.trim())
      }

      // Step 4: Re-author and inject Co-Authored-By trailer
      step = "reauthor"
      const modelName = record.model ? record.model.replace(/^synapse\//, "") : "auto"
      const trailer = `Co-Authored-By: OpenCode (Synapse ${modelName}) <opencode-delegate@users.noreply.github.com>`
      const lastMsg = (await ctx.hostExec(["git", "-C", targetDir, "log", "-n", "1", "--format=%B"])).stdout
      if (!lastMsg.includes("Co-Authored-By: OpenCode (Synapse")) {
        const authorArgs = args.author?.name && args.author?.email ? [`--author=${args.author.name} <${args.author.email}>`] : []
        const amendRes = await ctx.hostExec(["git", "-C", targetDir, "commit", "--amend", "--no-edit", `--trailer=${trailer}`, ...authorArgs])
        if (amendRes.code !== 0) {
          const newMsg = `${lastMsg.trimEnd()}\n\n${trailer}\n`
          await ctx.hostExec(["git", "-C", targetDir, "commit", "--amend", "-m", newMsg, ...authorArgs])
        }
      }
      const headSha = (await ctx.hostExec(["git", "-C", targetDir, "rev-parse", "HEAD"])).stdout.trim()

      // Step 5: Run verify commands
      step = "verify"
      const verifyResults: Array<{ command: string; exitCode: number; durationMs: number; stdout: unknown; stderr: unknown }> = []
      if (args.verify && args.verify.length > 0) {
        for (const cmd of args.verify) {
          const argv = parseCommand(cmd)
          const began = Date.now()
          const res = await ctx.hostExec(argv, 120_000, targetDir)
          const durationMs = Date.now() - began
          verifyResults.push({ command: cmd, exitCode: res.code, durationMs, stdout: untrusted(res.stdout, 4000), stderr: untrusted(res.stderr, 4000) })
          if (res.code !== 0) {
            throw new DelegateError("upstream_error", `Verification command '${cmd}' failed with exit code ${res.code}.`, "Fix verification errors and retry oc_land.", res.stderr.trim() || res.stdout.trim())
          }
        }
      }

      // Step 6: Push
      step = "push"
      if (args.push !== false) {
        const pushRes = await ctx.hostExec(["git", "-C", targetDir, "push", "origin", args.branch])
        if (pushRes.code !== 0) {
          throw new DelegateError("upstream_error", `Failed to push branch ${args.branch} to origin.`, "Check remote branch status and push permissions.", pushRes.stderr.trim())
        }
      }

      // Step 7: Open PR
      step = "pr"
      let prUrl: string | undefined
      if (args.pr) {
        const prArgs = ["gh", "pr", "create", "--head", args.branch, "--title", args.pr.title]
        if (args.pr.base) prArgs.push("--base", args.pr.base)
        if (args.pr.bodyFile) prArgs.push("--body-file", args.pr.bodyFile)
        else if (args.pr.body) prArgs.push("--body", args.pr.body)
        else prArgs.push("--body", "")
        const prRes = await ctx.hostExec(prArgs, 60_000, targetDir)
        if (prRes.code !== 0) {
          throw new DelegateError("upstream_error", "Failed to create pull request via gh CLI.", "Check gh authentication and repository settings.", prRes.stderr.trim())
        }
        const lines = prRes.stdout.trim().split(/\r?\n/)
        prUrl = lines.find((l) => l.startsWith("http://") || l.startsWith("https://")) ?? prRes.stdout.trim()
      }

      const stepsCompleted = [
        "collect",
        "worktree",
        "merge",
        "reauthor",
        ...(args.verify?.length ? ["verify"] : []),
        ...(args.push !== false ? ["push"] : []),
        ...(args.pr ? ["pr"] : []),
      ]

      return ok(`Landed ${args.branch} (HEAD at ${headSha.slice(0, 10)})${prUrl ? `; PR opened: ${prUrl}` : ""}.`, {
        landed: true,
        branch: args.branch,
        head: headSha,
        verify: verifyResults,
        prUrl,
        stepsCompleted,
      })
    } catch (error) {
      if (isDelegateError(error)) {
        throw new DelegateError(error.code, `[Step: ${step}] ${error.message}`, error.action, error.detail)
      }
      throw new DelegateError("upstream_error", `[Step: ${step}] Landing failed unexpectedly: ${String(error)}`, "Check step failure details and retry.")
    }
  },
})
