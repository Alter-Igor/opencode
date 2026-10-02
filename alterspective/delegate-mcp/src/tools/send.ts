// oc_send (technical-design §3.3, §3.5, §5): one prompt to one of our sessions.
// Order matters: permission re-read (H3) → runtime guard (§3.5, fails closed) → repo instructions
// → hub cursor BEFORE prompt_async (events that beat the 204 are not missed) → prompt_async →
// markSent (arms the not_started watchdog). The deprecated `tools` field is never sent.
// checkPolicy and sendPrompt are shared with oc_post's wake (inbox-tools.ts, W3A-19).
import { z } from "zod"
import type { Verdict } from "../shared/contracts.ts"
import { recordSend } from "../reporting/hooks.ts"
import { DelegateError } from "../shared/errors.ts"
import type { Box, SessionRecord, ToolContext } from "./context.ts"
import { readInstructions, type Instructions } from "./core-box.ts"
import { closingError, isClosing } from "./closing.ts"
import { CORRELATION_RE, agentSchema, formatCursor, modelSchema, ownSession, parseModel, requireSynapseModel, sameRules, sessionGone, sessionIdSchema } from "./core-session.ts"
import { DEFAULT_MODEL, SYNAPSE_PROVIDER } from "../supervisor/profile.ts"
import { defineTool } from "./define.ts"
import { boxDefault, fetchModels, requireModel } from "./models.ts"
import { ok } from "./shape.ts"

export const MAX_MESSAGE_CHARS = 100_000

function refused(verdict: Exclude<Verdict, { ok: true }>, what: string): DelegateError {
  const message =
    verdict.code === "policy_violation"
      ? `The sandbox has an MCP server that is not a Keystone entry, so ${what}.`
      : `The bridge could not verify the sandbox's MCP servers, so ${what}.`
  return new DelegateError(verdict.code, message, "Run oc_doctor; restart the sandbox with oc_server_restart if the profile changed.", verdict.reason)
}

/** H3 permission re-read, then the §3.5 runtime guard. `what` completes "…, so <what>." */
export async function checkPolicy(ctx: ToolContext, box: Box, record: SessionRecord, permission: Parameters<typeof sameRules>[0], what = "nothing was sent"): Promise<void> {
  if (!sameRules(permission, ctx.guard.permissionBaseline(record.profile, record.keystone)))
    throw new DelegateError("policy_violation", `This session's permission rules no longer match the bridge's baseline, so ${what}.`, "Start a new session with oc_start_session.", "session.permission differs from permissionBaseline")
  const verdict = await ctx.guard.checkRuntime(box.api, record.boxPath)
  if (!verdict.ok) throw refused(verdict, what)
}

export type Prompt = { text: string; model?: string; agent?: string; correlationId: string }
/** `modelFallback`: the session's saved model was not used (#71 review cycle 1), and why. */
export type Sent = { cursor: string; instructions: Instructions; modelFallback?: string }

/**
 * #71 review cycles 1-2: a session's SAVED model gets the same check as an explicit one. One the
 * sandbox no longer offers (another provider's, from before #71, or a Synapse model since retired)
 * is replaced by the sandbox default, SENT explicitly (leaving `model` out would make OpenCode reuse
 * the session's stored model), and the reason names the model actually sent. Every send names a
 * Synapse model (cycle 3).
 */
async function savedModel(box: Box, saved: string | undefined, correlationId: string): Promise<{ model?: string; fallback?: string }> {
  // Cycle 3: nothing saved still names a model: OpenCode would otherwise reuse the session's stored one.
  if (!saved) return { model: await boxDefault(box.api, correlationId) }
  if (saved === DEFAULT_MODEL) return { model: saved }
  const why =
    parseModel(saved).providerID !== SYNAPSE_PROVIDER ? "is not a Synapse model" : (await fetchModels(box.api, correlationId)).includes(saved) ? undefined : "is no longer offered by the sandbox"
  if (!why) return { model: saved }
  const model = await boxDefault(box.api, correlationId)
  return { model, fallback: `The session's saved model ${saved} ${why}; the sandbox default ${model} was sent instead.` }
}

/** Instructions, cursor, prompt_async, markSent: the one way a prompt reaches a session. */
export async function sendPrompt(ctx: ToolContext, box: Box, record: SessionRecord, prompt: Prompt): Promise<Sent> {
  // #71: an explicit model was checked by the caller (requireModel); this is the last guard.
  if (prompt.model) requireSynapseModel(prompt.model)
  const saved = prompt.model ? {} : await savedModel(box, record.model, prompt.correlationId)
  const model = prompt.model ?? saved.model
  const agent = prompt.agent ?? record.agent
  const instructions = await readInstructions(ctx, record)
  const body = {
    parts: [{ type: "text", text: prompt.text }],
    ...(model ? { model: parseModel(model) } : {}),
    ...(agent ? { agent } : {}),
    ...(instructions.system ? { system: instructions.system } : {}),
  }
  // Combined review: a close may have started while this send waited (the default-model read, the
  // instructions read). Checked again with no await before the POST, so it reaches no closing session.
  if (isClosing(ctx, record.sessionID)) throw closingError(record.sessionID)
  const cursor = box.hub.cursor()
  // #73: the run's start for the task record, taken before the POST (a fast run can settle during it).
  const sendStartedAt = new Date().toISOString()
  const res = await box.api.call({ method: "POST", path: `/session/${encodeURIComponent(record.sessionID)}/prompt_async`, directory: record.boxPath, body, correlationId: prompt.correlationId })
  if (res.status === 404) throw sessionGone(record.sessionID)
  if (res.status < 200 || res.status >= 300) throw new DelegateError("upstream_error", "The delegate server did not accept the message.", "Check oc_status, then retry.", `HTTP ${res.status}`)
  box.hub.markSent(record.sessionID)
  // #73: metadata only (the model and agent sent); the prompt text never reaches the record.
  recordSend(ctx, record, { model, agent, at: sendStartedAt })
  ctx.log.log("info", "tools", "prompt sent", { sessionID: record.sessionID, correlationId: prompt.correlationId, instructions: instructions.files.join(","), instructionsTruncated: instructions.truncated, instructionsFailed: (instructions.failed ?? []).join(","), savedModelFallback: saved.fallback !== undefined })
  return { cursor: formatCursor(cursor), instructions, ...(saved.fallback ? { modelFallback: saved.fallback } : {}) }
}

function instructionReport(i: Instructions): Record<string, unknown> {
  return { files: i.files, truncated: i.truncated, ...(i.skipped ? { skipped: i.skipped } : {}), ...(i.failed ? { failed: i.failed } : {}) }
}

export const sendTool = defineTool({
  name: "oc_send",
  title: "Send a task to a session",
  description:
    "Send a message (a task) to one of this bridge's sessions. Returns at once with accepted:true and a cursor; pass the cursor to oc_wait. Refused (policy_violation / policy_unverified) when the sandbox's MCP servers are not all Keystone entries. The repo's AGENTS.md and CLAUDE.md (as committed at the session's base) are passed along as instructions; `instructions.failed` names any that could not be read.",
  input: {
    sessionID: sessionIdSchema,
    message: z.string().min(1).max(MAX_MESSAGE_CHARS),
    model: modelSchema.optional().describe("synapse/<id> for this send (see oc_list_models); default the session's model, else synapse/auto."),
    agent: agentSchema.optional(),
    correlationId: z.string().regex(CORRELATION_RE).optional().describe("Your id for this task; sent as X-Correlation-ID and logged."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run(args, ctx, correlationId) {
    const cid = args.correlationId ?? correlationId
    const box = await ctx.box()
    const { record, remote } = await ownSession(ctx, box, args.sessionID, cid, true)
    await checkPolicy(ctx, box, record, remote?.permission)
    if (args.model) await requireModel(box.api, args.model, cid)
    const sent = await sendPrompt(ctx, box, record, { text: args.message, model: args.model, agent: args.agent, correlationId: cid })
    const warn =
      (sent.instructions.failed ? ` Warning: could not read ${sent.instructions.failed.join(", ")} from the repository, so it was not passed on.` : "") +
      (sent.modelFallback ? ` Warning: ${sent.modelFallback}` : "")
    return ok(`Accepted by ${record.sessionID}. Call oc_wait with this cursor.${warn}`, {
      accepted: true,
      sessionID: record.sessionID,
      cursor: sent.cursor,
      correlationId: cid,
      instructions: instructionReport(sent.instructions),
      ...(sent.modelFallback ? { modelFallback: sent.modelFallback } : {}),
    })
  },
})
