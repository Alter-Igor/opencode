// MOD-04 interaction tools (oc_pending, oc_answer, oc_post, oc_inbox). Owned by the Wave 3
// interaction build; the server registers whatever this list exports.
//
// `startInteraction` wires the two background pieces to every box the bridge holds (first start
// and after oc_server_restart, via ctx.onBox): the inbox poller (inbox → hub `inbox` events) and,
// when --channels is on, the Claude channel push. The server owner calls
// declareChannelCapability(server) BEFORE connect when channels are on, then startInteraction.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { z } from "zod"
import { attachChannels } from "../channels.ts"
import { startInboxPoller } from "../inbox-poller.ts"
import { ocAnswer } from "./answer.ts"
import type { Box, ToolContext } from "./context.ts"
import type { ToolSpec } from "./define.ts"
import { ocInbox, ocPost } from "./inbox-tools.ts"
import { ocPending } from "./pending.ts"

export const interactionTools: Array<ToolSpec<z.ZodRawShape>> = [ocPending, ocAnswer, ocPost, ocInbox]

export type InteractionOptions = { channels: boolean; pollIntervalMs?: number; channelIntervalMs?: number }

/** Start the inbox poller and (optionally) channel push for the current and every later box. Returns stop. */
export function startInteraction(server: McpServer, ctx: ToolContext, options: InteractionOptions): () => void {
  let attached: Box | undefined
  let stops: Array<() => void> = []
  const detach = () => {
    for (const stop of stops) stop()
    stops = []
  }
  const attach = (box: Box) => {
    if (box === attached) return
    detach()
    attached = box
    stops = [
      startInboxPoller(ctx, box.hub, { intervalMs: options.pollIntervalMs }),
      attachChannels(server, box.hub, { enabled: options.channels, intervalMs: options.channelIntervalMs, log: ctx.log }),
    ]
  }
  const unsubscribe = ctx.onBox(attach)
  const current = ctx.peekBox()
  if (current) attach(current)
  return () => {
    unsubscribe()
    detach()
    attached = undefined
  }
}
