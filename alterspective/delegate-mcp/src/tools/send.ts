// oc_send (technical-design §3.3, §3.5, §5): one prompt to one of our sessions.
// Order matters: permission re-read (H3) → runtime guard (§3.5, fails closed) → repo instructions
// → hub cursor BEFORE prompt_async (events that beat the 204 are not missed) → prompt_async →
// markSent (arms the not_started watchdog). The deprecated `tools` field is never sent.
import { z } from "zod"
import type { Verdict } from "../shared/contracts.ts"
import { DelegateError } from "../shared/errors.ts"
import type { Box, SessionRecord, ToolContext } from "./context.ts"
import { readInstructions } from "./core-box.ts"
import { CORRELATION_RE, agentSchema, formatCursor, modelSchema, ownSession, parseModel, sameRules, sessionIdSchema } from "./core-session.ts"
import { defineTool } from "./define.ts"
import { requireModel } from "./models.ts"
import { ok } from "./shape.ts"

export const MAX_MESSAGE_CHARS = 100_000

function refused(verdict: Exclude<Verdict, { ok: true }>): DelegateError {
  const message =
    verdict.code === "policy_violation"
      ? "The sandbox has an MCP server that is not a Keystone entry, so nothing was sent."
      : "The bridge could not verify the sandbox's MCP servers, so nothing was sent."
  return new DelegateError(verdict.code, message, "Run oc_doctor; restart the sandbox with oc_server_restart if the profile changed.", verdict.reason)
}

async function checkPolicy(ctx: ToolContext, box: Box, record: SessionRecord, permission: Parameters<typeof sameRules>[0]): Promise<void> {
  if (!sameRules(permission, ctx.guard.permissionBaseline(record.profile)))
    throw new DelegateError("policy_violation", "This session's permission rules no longer match the bridge's baseline, so nothing was sent.", "Start a new session with oc_start_session.", "session.permission differs from permissionBaseline")
  const verdict = await ctx.guard.checkRuntime(box.api, record.boxPath)
  if (!verdict.ok) throw refused(verdict)
}

type SendArgs = { sessionID: string; message: string; model?: string; agent?: string; correlationId?: string }

async function buildBody(ctx: ToolContext, box: Box, record: SessionRecord, args: SendArgs, correlationId: string) {
  const model = args.model ?? record.model
  if (args.model) await requireModel(box.api, args.model, correlationId)
  const agent = args.agent ?? record.agent
  const instructions = await readInstructions(ctx, record)
  const body = {
    parts: [{ type: "text", text: args.message }],
    ...(model ? { model: parseModel(model) } : {}),
    ...(agent ? { agent } : {}),
    ...(instructions.system ? { system: instructions.system } : {}),
  }
  return { body, instructions }
}

export const sendTool = defineTool({
  name: "oc_send",
  title: "Send a task to a session",
  description:
    "Send a message (a task) to one of this bridge's sessions. Returns at once with accepted:true and a cursor; pass the cursor to oc_wait. Refused (policy_violation / policy_unverified) when the sandbox's MCP servers are not all Keystone entries. The repo's AGENTS.md and CLAUDE.md are passed along as instructions.",
  input: {
    sessionID: sessionIdSchema,
    message: z.string().min(1).max(MAX_MESSAGE_CHARS),
    model: modelSchema.optional().describe("provider/model for this send; default the session's model."),
    agent: agentSchema.optional(),
    correlationId: z.string().regex(CORRELATION_RE).optional().describe("Your id for this task; sent as X-Correlation-ID and logged."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run(args, ctx, correlationId) {
    const cid = args.correlationId ?? correlationId
    const box = await ctx.box()
    const { record, remote } = await ownSession(ctx, box, args.sessionID, cid, true)
    await checkPolicy(ctx, box, record, remote?.permission)
    const { body, instructions } = await buildBody(ctx, box, record, args, cid)
    const cursor = box.hub.cursor()
    const res = await box.api.call({ method: "POST", path: `/session/${record.sessionID}/prompt_async`, directory: record.boxPath, body, correlationId: cid })
    if (res.status < 200 || res.status >= 300) throw new DelegateError("upstream_error", "The delegate server did not accept the message.", "Check oc_status, then retry.", `HTTP ${res.status}`)
    box.hub.markSent(record.sessionID)
    ctx.log.log("info", "tools", "prompt sent", { sessionID: record.sessionID, correlationId: cid, instructions: instructions.files.join(","), instructionsTruncated: instructions.truncated })
    return ok(`Accepted by ${record.sessionID}. Call oc_wait with this cursor.`, {
      accepted: true,
      sessionID: record.sessionID,
      cursor: formatCursor(cursor),
      correlationId: cid,
      instructions: { files: instructions.files, truncated: instructions.truncated, ...(instructions.skipped ? { skipped: instructions.skipped } : {}) },
    })
  },
})
