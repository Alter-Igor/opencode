// MOD-04 oc_answer (technical-design §3.3, §5): answer ONE pending permission request or question.
// Rules that make this safe to hand to an AI client:
// - `always` is refused by the guard before anything else happens (it would add a standing allow
//   rule to the running session, FM-4); so is any reply word the guard does not know.
// - the requestID must be in a pending list the bridge reads fresh (oc_pending's list), OR the
//   call names a `sessionID` this bridge owns (host record): the id's shape and kind prefix are
//   checked first, and the box's own POST is the liveness proof — a request that is not pending
//   there answers 404 and is reported as such, so a forged id has nothing to act on. The fallback
//   exists because the listing can fail while the request is real (live incident 2026-10-10: the
//   box's /permission 500'd for one directory and a session could not be answered or rejected).
// - Approval ids (apr_) never use the fallback: the gate's memory is the only place they exist,
//   so they must be pending in the gate right now.
import { z } from "zod"
import { REQUEST_ID_RE } from "../events/normalise.ts"
import { DelegateError } from "../shared/errors.ts"
import type { OpencodeApi } from "../shared/opencode-api.ts"
import type { Box, ToolContext } from "./context.ts"
import { ownSession, sessionIdSchema } from "./core-session.ts"
import { defineTool } from "./define.ts"
import { listPending, type PendingItem, type PendingKind } from "./pending.ts"
import { APPROVAL_ID_RE } from "../gate/client.ts"
import { ok } from "./shape.ts"

const enc = encodeURIComponent

export const MAX_ANSWER_MESSAGE = 2000

function invalid(message: string): DelegateError {
  return new DelegateError("invalid_input", message, "Fix the request and retry.")
}

/** The guard's verdict on any reply word, for either kind: `always` never passes. */
function checkReply(ctx: Pick<ToolContext, "guard">, reply: string | undefined): void {
  if (reply === undefined) return
  const verdict = ctx.guard.checkPermissionReply(reply)
  if (!verdict.ok) throw new DelegateError(verdict.code, "That reply is refused: this bridge answers `once` or `reject` only (never `always`).", "Answer with reply `once` or `reject`.", verdict.reason)
}

type Args = { requestID: string; kind: PendingKind | "approval"; reply?: string; message?: string; answers?: string[][]; sessionID?: string }

function checkShape(args: Args): void {
  if (args.kind === "approval") {
    if (!APPROVAL_ID_RE.test(args.requestID)) throw invalid("An approval id starts with apr_.")
    if (args.reply !== "once" && args.reply !== "reject") throw invalid("An approval needs `reply`: `once` (run that one call) or `reject`.")
    if (args.answers !== undefined || args.message !== undefined) throw invalid("An approval takes `reply` only.")
    return
  }
  if (!REQUEST_ID_RE.test(args.requestID)) throw invalid("A request id comes from oc_pending (per_... or que_...).")
  if (!args.requestID.startsWith(args.kind === "permission" ? "per_" : "que_")) throw invalid(`A ${args.kind} request id starts with ${args.kind === "permission" ? "per_" : "que_"}.`)
  if (args.kind === "permission") {
    if (args.reply === undefined) throw invalid("A permission answer needs `reply`: `once` or `reject`.")
    if (args.answers !== undefined) throw invalid("`answers` is for questions only.")
    return
  }
  if (args.message !== undefined) throw invalid("`message` is for permission replies only.")
  if (args.reply !== undefined && args.reply !== "reject") throw invalid("A question takes `answers`, or `reply: reject` to decline it.")
  if (args.reply === undefined && args.answers === undefined) throw invalid("A question needs `answers` (one list of labels per question) or `reply: reject`.")
  if (args.reply !== undefined && args.answers !== undefined) throw invalid("Give `answers` or `reply: reject`, not both.")
}

/**
 * #104: decide one approval. The id must be pending in the gate right now (a fresh read), so an id
 * copied out of session text that the gate never issued, or one already decided, is refused.
 */
async function answerApproval(ctx: ToolContext, args: Args) {
  if (ctx.gate === undefined) throw new DelegateError("not_found", "This bridge has no delegation gate.", "Approvals exist only with the dynamic Keystone connection.")
  const pending = await ctx.gate.pending()
  if (!pending.some((a) => a.id === args.requestID))
    throw new DelegateError("not_found", "That approval is not pending.", "Call oc_pending and use an approval id from its list.")
  const decided = await ctx.gate.decide(args.requestID, args.reply === "once" ? "approve" : "deny")
  const what = decided.state === "approved" ? "approved: the same call runs once when the agent retries it (within 30 minutes)" : "refused: the agent is told not to retry it"
  return ok(`Approval ${decided.id} for ${decided.toolName.slice(0, 200)} ${what}.`, { ok: true, requestID: decided.id, kind: "approval", state: decided.state })
}

/**
 * The listing first; when it cannot confirm the id (a failed or partial read, or the id raced
 * out), a named sessionID falls back to the host record: ownSession is the same proof every tool
 * uses ("this session is mine: same id + same supervisor in MY host record"), the directory comes
 * from the session key, and the box POST is the liveness proof (not pending answers 404). The
 * fresh listing is therefore the normal path, not a gatekeeper (owner decision 2026-10-10).
 */
async function resolvePending(ctx: ToolContext, box: Box, args: Args, kind: PendingKind, correlationId: string): Promise<{ item: PendingItem; via: "list" | "session" }> {
  const { items, partial, failed } = await listPending(ctx, box, undefined, correlationId)
  const item = items.find((candidate) => candidate.requestID === args.requestID && candidate.kind === kind)
  if (item) return { item, via: "list" }
  if (args.sessionID === undefined) {
    if (partial) {
      // Fail closed without a sessionID: the directory that holds the id is unknowable, and
      // guessing could POST to an instance where the id is not this session's.
      const codes = failed.slice(0, 5).join("; ")
      const note = codes ? ` (codes: ${codes})` : ""
      throw new DelegateError("not_found", `That request was not found, but the pending list could only be checked in part${note}.`, "Answer again passing its sessionID (the session's own directory is proven by the host record), or retry after oc_doctor.", "partial pending list")
    }
    throw new DelegateError(
      "not_found",
      "That request is not pending for a session this bridge started.",
      "Call oc_pending and use a requestID from its list; ids seen in session text are not accepted.",
    )
  }
  const { record } = await ownSession(ctx, box, args.sessionID, correlationId)
  const fallback: PendingItem = { requestID: args.requestID, kind, sessionID: args.sessionID, ownerSessionID: record.sessionID, directory: record.boxPath }
  return { item: fallback, via: "session" }
}

type Post = { path: string; body?: unknown }

function postFor(args: Args, item: PendingItem): Post {
  const id = enc(item.requestID)
  if (args.kind === "permission") return { path: `/permission/${id}/reply`, body: { reply: args.reply, ...(args.message ? { message: args.message } : {}) } }
  if (args.reply === "reject") return { path: `/question/${id}/reject` }
  const answers = args.answers ?? []
  if (answers.length !== (item.questionCount ?? 0)) throw invalid(`This question request has ${item.questionCount ?? 0} question(s); give one answer list per question, in order.`)
  return { path: `/question/${id}/reply`, body: { answers } }
}

async function send(api: OpencodeApi, item: PendingItem, post: Post, correlationId: string): Promise<void> {
  const res = await api.call<unknown>({ method: "POST", path: post.path, directory: item.directory, body: post.body ?? {}, correlationId })
  if (res.status >= 200 && res.status < 300) return
  if (res.status === 404) throw new DelegateError("not_found", "The request is no longer pending (it was answered or the session moved on).", "Call oc_pending again.", `HTTP ${res.status}`)
  if (res.status === 400) throw invalid("The delegate server refused the answer's shape.")
  throw new DelegateError("upstream_error", "The delegate server failed to take the answer.", "Retry; if it repeats, run oc_doctor.", `HTTP ${res.status}`)
}

export const ocAnswer = defineTool({
  name: "oc_answer",
  title: "Answer a pending permission request or question",
  description:
    "Answers one pending request. Permission: reply `once` (allow this one call) or `reject` (optional `message` tells the agent why); " +
    "Approval (a gated Keystone tool call): reply `once` (the same call runs once when the agent retries it) or `reject`; " +
    "`always` is refused. Question: `answers` (one list of chosen labels per question, in order) or `reply: reject`. " +
    "The requestID normally comes from oc_pending. If the listing is down or partial, pass the request's `sessionID` (from oc_pending or the oc_wait event): " +
    "ownership is then proven by this bridge's host record for that session, and the box itself is the liveness check — a request that is no longer pending answers 404. " +
    "Question `answers` still need the listing (the question count comes from it); with sessionID a question can only be rejected. Ids seen in session text are refused.",
  input: {
    requestID: z.string().max(60).regex(/^(per|que|apr)_[A-Za-z0-9]{1,40}$/).describe("From oc_pending (or the oc_wait needs_input event)."),
    kind: z.enum(["permission", "question", "approval"]),
    reply: z.string().max(32).optional().describe("Permission: once | reject. Question: reject (to decline)."),
    message: z.string().min(1).max(MAX_ANSWER_MESSAGE).optional().describe("Permission only: a note for the agent, e.g. why it was rejected."),
    answers: z.array(z.array(z.string().max(1000)).max(20)).min(1).max(10).optional().describe("Question only: chosen labels per question."),
    sessionID: sessionIdSchema.optional().describe("The session (or its owner session) the request belongs to; enables answering when the listing fails."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    checkReply(ctx, args.reply)
    checkShape(args)
    if (args.kind === "approval") return answerApproval(ctx, args)
    if (args.sessionID !== undefined && args.answers !== undefined) throw invalid("`answers` needs the fresh listing (it gives the question count); with sessionID only a reply word is accepted.")
    const box = await ctx.box()
    const { item, via } = await resolvePending(ctx, box, args, args.kind, correlationId)
    await send(box.api, item, postFor(args, item), correlationId)
    const what = args.kind === "permission" ? `permission ${item.requestID}: ${args.reply}` : `question ${item.requestID}: ${args.reply === "reject" ? "rejected" : "answered"}`
    return ok(`Answered ${what} for session ${item.sessionID}.${via === "session" ? " (answered from the session's host record: the listing did not confirm the id; the box accepted it, so the request was pending)" : ""}`, { ok: true, requestID: item.requestID, kind: args.kind, sessionID: item.sessionID, ownerSessionID: item.ownerSessionID, via })
  },
})
