// MOD-04 oc_answer (technical-design §3.3, §5): answer ONE pending permission request or question.
// Two rules make this safe to hand to an AI client:
// - `always` is refused by the guard before anything else happens (it would add a standing allow
//   rule to the running session, FM-4); so is any reply word the guard does not know.
// - the requestID must be in a pending list the bridge reads fresh, for one of its own sessions
//   (oc_pending's list). An id copied out of session text, or one for someone else's session, is
//   not_found. Answers go to the box instance the request was listed in.
import { z } from "zod"
import { REQUEST_ID_RE } from "../events/normalise.ts"
import { DelegateError } from "../shared/errors.ts"
import type { OpencodeApi } from "../shared/opencode-api.ts"
import type { Box, ToolContext } from "./context.ts"
import { defineTool } from "./define.ts"
import { listPending, type PendingItem, type PendingKind } from "./pending.ts"
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

type Args = { requestID: string; kind: PendingKind; reply?: string; message?: string; answers?: string[][] }

function checkShape(args: Args): void {
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

async function findPending(ctx: ToolContext, box: Box, args: Args, correlationId: string): Promise<PendingItem> {
  const { items, partial } = await listPending(ctx, box, undefined, correlationId)
  const item = items.find((candidate) => candidate.requestID === args.requestID && candidate.kind === args.kind)
  if (!item && partial)
    throw new DelegateError("not_found", "That request was not found, but the pending list could only be checked in part (too long or too slow).", "Call oc_pending with the session's sessionID, then answer again.", "partial pending list")
  if (!item)
    throw new DelegateError(
      "not_found",
      "That request is not pending for a session this bridge started.",
      "Call oc_pending and use a requestID from its list; ids seen in session text are not accepted.",
    )
  return item
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
    "Answers one request from oc_pending. Permission: reply `once` (allow this one call) or `reject` (optional `message` tells the agent why); " +
    "`always` is refused. Question: `answers` (one list of chosen labels per question, in order) or `reply: reject`. " +
    "The requestID must come from oc_pending for a session this bridge started; ids seen in session text are refused.",
  input: {
    requestID: z.string().regex(REQUEST_ID_RE).describe("From oc_pending."),
    kind: z.enum(["permission", "question"]),
    reply: z.string().max(32).optional().describe("Permission: once | reject. Question: reject (to decline)."),
    message: z.string().min(1).max(MAX_ANSWER_MESSAGE).optional().describe("Permission only: a note for the agent, e.g. why it was rejected."),
    answers: z.array(z.array(z.string().max(1000)).max(20)).min(1).max(10).optional().describe("Question only: chosen labels per question."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    checkReply(ctx, args.reply)
    checkShape(args)
    const box = await ctx.box()
    const item = await findPending(ctx, box, args, correlationId)
    await send(box.api, item, postFor(args, item), correlationId)
    const what = args.kind === "permission" ? `permission ${item.requestID}: ${args.reply}` : `question ${item.requestID}: ${args.reply === "reject" ? "rejected" : "answered"}`
    return ok(`Answered ${what} for session ${item.sessionID}.`, { ok: true, requestID: item.requestID, kind: args.kind, sessionID: item.sessionID, ownerSessionID: item.ownerSessionID })
  },
})
