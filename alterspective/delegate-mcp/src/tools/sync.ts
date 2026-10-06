// oc_sync (#143): fetch a host ref into the session's workspace copy and fast-forward or merge it.
import { z } from "zod"
import { ownSession, sessionIdSchema } from "./core-session.ts"
import { defineTool } from "./define.ts"
import { ok } from "./shape.ts"

export const syncTool = defineTool({
  name: "oc_sync",
  title: "Sync host commits into a session",
  description:
    "Fetch a host git ref (a branch, tag, commit SHA, or HEAD) into the session's workspace copy and merge/fast-forward it. Refuses if the session copy has uncommitted files. If a merge produces conflicts, the merge is automatically aborted to preserve a clean workspace and conflicted files are reported.",
  input: {
    sessionID: sessionIdSchema,
    ref: z.string().min(1).max(128).describe("The host git ref (branch name, tag, commit SHA, or HEAD) to sync into the session workspace."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const box = await ctx.box()
    const { record } = await ownSession(ctx, box, args.sessionID, correlationId)
    const result = await ctx.workspaces.sync(
      { sessionKey: record.sessionKey, hostRepo: record.hostRepo, boxPath: record.boxPath, branch: record.branch },
      args.ref,
      { correlationId },
    )
    if (result.synced) {
      return ok(`Synced ref ${args.ref} into ${record.sessionID} (HEAD is now ${result.head.slice(0, 10)}; ${result.commitsSynced} commit${result.commitsSynced === 1 ? "" : "s"} synced).`, {
        synced: true,
        sessionID: record.sessionID,
        ref: args.ref,
        head: result.head,
        commitsSynced: result.commitsSynced,
      })
    }
    return ok(`Sync could not be merged into ${record.sessionID}: ${result.reason}`, {
      synced: false,
      sessionID: record.sessionID,
      ref: args.ref,
      conflicts: result.conflicts,
      reason: result.reason,
    })
  },
})
