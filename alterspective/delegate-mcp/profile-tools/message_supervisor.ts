// FEAT-OCD-001 MOD-05 T5.2: in-box tool `message_supervisor` (see inbox-lib.ts for the trust model).
// The supervisor is read from this session's metadata, which the bridge sets when it creates the
// session; the model never names it, so it cannot address a supervisor by mistake. A per-box env
// var would be wrong (several bridges share one box) and a `to` argument would be guesswork.
import { InboxToolError, postMessage, selfAddress, sentText, supervisorOf, textArg, threadArg, type ToolContext } from "./inbox-lib.ts"

export default {
  description: [
    "Send a short message to your supervisor: the AI client (via its bridge) that started this session.",
    "Use it for a status update, a question you cannot answer yourself, or to say you are blocked.",
    "It does not wake the supervisor; they read it when they next check their inbox.",
    "Your message is stored as AI-written and from an unverified sender. Max 8 KB.",
  ].join(" "),
  args: {
    text: { type: "string", description: "The message. Plain text, at most 8 KB." },
    correlationId: {
      type: "string",
      description: 'Thread id from read_inbox when replying; "" continues your latest thread with the supervisor; "new" starts a new thread.',
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const self = selfAddress(ctx)
    const text = textArg(args.text)
    const to = await supervisorOf(ctx)
    if (to === self) throw new InboxToolError("A session cannot message itself.")
    const message = await postMessage({ from: self, to, text, correlationId: threadArg(args.correlationId, self, to) })
    return sentText(message)
  },
}
