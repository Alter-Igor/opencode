// FEAT-OCD-001 MOD-05 T5.2: in-box tool `message_session` (see inbox-lib.ts for the trust model).
import { InboxToolError, SESSION_ADDRESS, postMessage, rememberSent, selfAddress, sentText, textArg, threadArg, type ToolContext } from "./inbox-lib.ts"

function peerAddress(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : ""
  const address = raw.startsWith("session:") ? raw : `session:${raw}`
  if (!SESSION_ADDRESS.test(address)) throw new InboxToolError("`sessionID` must be an OpenCode session id such as ses_01J5Y5H0AH4Q4NXJ6P4C3P5V2K.")
  return address
}

export default {
  description: [
    "Send a short message to another OpenCode session in this sandbox, by its session id.",
    "It does not wake that session; it reads the message when it next calls read_inbox.",
    "Your message is stored as AI-written and from an unverified sender. Max 8 KB.",
    "Replies in one thread stop after 3 hops, so do not ping-pong.",
  ].join(" "),
  args: {
    sessionID: { type: "string", description: "The other session's id (ses_...)." },
    text: { type: "string", description: "The message. Plain text, at most 8 KB." },
    correlationId: {
      type: "string",
      description: 'Thread id from read_inbox when replying; "" continues your latest thread with that session; "new" starts a new thread.',
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const self = selfAddress(ctx)
    const to = peerAddress(args.sessionID)
    if (to === self) throw new InboxToolError("A session cannot message itself.")
    const text = textArg(args.text)
    const message = await postMessage({ from: self, to, text, correlationId: threadArg(args.correlationId, self, to) })
    rememberSent(self, message)
    return sentText(message)
  },
}
