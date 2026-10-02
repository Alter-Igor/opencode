// oc_collect (technical-design §4): fetch the session branch back into the owner's repository as
// delegate/<key>. Nothing is merged or checked out; the owner reviews the branch like a PR. Files
// the agent changed that the host could execute (hooks, scripts, CI) are flagged loudly.
import { recordCollect } from "../reporting/hooks.ts"
import { DelegateError } from "../shared/errors.ts"
import type { Box, SessionRecord, ToolContext } from "./context.ts"
import { defineTool } from "./define.ts"
import { ownSession, ownedStates, recordFromState, sessionIdSchema } from "./core-session.ts"
import { ok, untrusted } from "./shape.ts"

/**
 * #72: the record to collect from. When the sandbox no longer has the session (HTTP 404) but this
 * bridge's host record for this box still names it, e.g. after oc_close_session kept the copy
 * because work appeared while closing and the bridge then restarted, the copy is collected from the
 * host record. Collect needs only the clone, never the OpenCode session.
 */
async function collectRecord(ctx: ToolContext, box: Box, sessionID: string, correlationId: string): Promise<SessionRecord> {
  try {
    return (await ownSession(ctx, box, sessionID, correlationId)).record
  } catch (error) {
    if (!(error instanceof DelegateError) || error.code !== "not_found" || error.detail !== "HTTP 404") throw error
    const state = (await ownedStates(ctx)).find((s) => s.sessionID === sessionID && s.boxProject === ctx.config.project)
    if (!state) throw error
    return recordFromState(ctx, state)
  }
}

export const collectTool = defineTool({
  name: "oc_collect",
  title: "Collect a session's branch",
  description:
    "Fetch the session's branch (delegate/<key>) into the owner's repository. Nothing is merged or checked out. Warns when the agent changed files the host could execute (git hooks, scripts, CI config): review those before running anything.",
  input: { sessionID: sessionIdSchema },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const box = await ctx.box()
    const record = await collectRecord(ctx, box, args.sessionID, correlationId)
    const result = await ctx.workspaces.collect({ sessionKey: record.sessionKey, hostRepo: record.hostRepo, boxPath: record.boxPath, branch: record.branch })
    await recordCollect(ctx, record, result.commits)
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
