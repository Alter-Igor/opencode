// oc_collect (technical-design §4): fetch the session branch back into the owner's repository as
// delegate/<key>. Nothing is merged or checked out; the owner reviews the branch like a PR. Files
// the agent changed that the host could execute (hooks, scripts, CI) are flagged loudly.
import { defineTool } from "./define.ts"
import { ownSession, sessionIdSchema } from "./core-session.ts"
import { ok, untrusted } from "./shape.ts"

export const collectTool = defineTool({
  name: "oc_collect",
  title: "Collect a session's branch",
  description:
    "Fetch the session's branch (delegate/<key>) into the owner's repository. Nothing is merged or checked out. Warns when the agent changed files the host could execute (git hooks, scripts, CI config): review those before running anything.",
  input: { sessionID: sessionIdSchema },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const box = await ctx.box()
    const { record } = await ownSession(ctx, box, args.sessionID, correlationId)
    const result = await ctx.workspaces.collect({ sessionKey: record.sessionKey, hostRepo: record.hostRepo, boxPath: record.boxPath, branch: record.branch })
    const risky = result.hostExecutableChanges
    const warning = risky.length
      ? `WARNING: ${risky.length} changed file${risky.length === 1 ? "" : "s"} can run on the host (hooks, scripts or CI). Review them before running anything from ${result.branch}.`
      : undefined
    const summary = `${result.branch} fetched into the owner's repo with ${result.commits} commit${result.commits === 1 ? "" : "s"}.${warning ? ` ${warning}` : ""}`
    return ok(summary, {
      sessionID: record.sessionID,
      hostRepo: record.hostRepo,
      branch: result.branch,
      commits: result.commits,
      hostExecutableChanges: { count: risky.length, ...(warning ? { warning, paths: untrusted(risky.join("\n"), 4000) } : {}) },
    })
  },
})
