// oc_wait and oc_events (technical-design §5, §6): long-poll and page the hub's event buffer.
// Event summaries are bridge words (contracts.ts HubEvent); anything the box supplied is only
// ever returned under `untrusted`.
import { z } from "zod"
import type { HubEvent, WaitUntil } from "../shared/contracts.ts"
import type { ToolContext } from "./context.ts"
import { cursorSchema, formatCursor, ownSession, parseCursor, sessionIdSchema } from "./core-session.ts"
import { defineTool } from "./define.ts"
import { ok, untrusted } from "./shape.ts"

export const MAX_WAIT_SEC = 240
export const DEFAULT_WAIT_SEC = 120
export const MAX_EVENTS = 200
const DEFAULT_UNTIL: WaitUntil[] = ["idle", "needs_input", "error"]

export function shapeEvent(e: HubEvent) {
  return {
    cursor: formatCursor(e.cursor),
    at: e.at,
    type: e.type,
    ...(e.sessionID ? { sessionID: e.sessionID } : {}),
    ...(e.parentID ? { parentID: e.parentID } : {}),
    ...(e.state ? { state: e.state } : {}),
    summary: e.summary,
    ...(e.requestID ? { requestID: e.requestID } : {}),
    ...(e.untrusted !== undefined ? { untrusted: untrusted(e.untrusted, 2000) } : {}),
  }
}

/** Keep at most `max` events; `next` then points at the last one kept so nothing is skipped. */
function capEvents(events: HubEvent[], next: string, max: number) {
  if (events.length <= max) return { events: events.map(shapeEvent), next, more: false }
  const kept = events.slice(0, max)
  const last = kept[kept.length - 1]
  return { events: kept.map(shapeEvent), next: last ? formatCursor(last.cursor) : next, more: true }
}

async function checkOwned(ctx: ToolContext, ids: string[], correlationId: string) {
  const box = await ctx.box()
  for (const id of ids) await ownSession(ctx, box, id, correlationId)
  return box
}

export const waitTool = defineTool({
  name: "oc_wait",
  title: "Wait for sessions",
  description:
    "Wait until any of the given sessions reaches one of the `until` states (default idle, needs_input, error) or the timeout passes. Pass the cursor from oc_send so nothing that happened after the send is missed. On timeout returns still_running:true and the next cursor: call again.",
  input: {
    sessionIDs: z.array(sessionIdSchema).min(1).max(20),
    until: z.array(z.enum(["idle", "needs_input", "error", "message"])).min(1).optional(),
    timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).optional().describe(`Default ${DEFAULT_WAIT_SEC}, at most ${MAX_WAIT_SEC}.`),
    cursor: cursorSchema.optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const box = await checkOwned(ctx, args.sessionIDs, correlationId)
    const timeoutMs = (args.timeoutSec ?? DEFAULT_WAIT_SEC) * 1000
    const result = await box.hub.wait({ sessionIDs: args.sessionIDs, until: args.until ?? DEFAULT_UNTIL, timeoutMs, cursor: parseCursor(args.cursor) })
    const page = capEvents(result.events, formatCursor(result.next), 100)
    const views = result.views ?? []
    if (result.timedOut) {
      const states = await Promise.all(args.sessionIDs.map((id) => box.hub.view(id)))
      return ok(`Still running after ${timeoutMs / 1000} s. Call oc_wait again with the next cursor.`, { still_running: true, next: page.next, events: page.events, views: states })
    }
    const matched = [...page.events.filter((e) => e.state).map((e) => `${e.sessionID ?? "?"} ${e.state}`), ...views.map((v) => `${v.sessionID} ${v.state}`)]
    return ok(`Done waiting: ${matched.join("; ") || "matching event"}.`, { still_running: false, next: page.next, events: page.events, views, ...(page.more ? { more: true } : {}) })
  },
})

export const eventsTool = defineTool({
  name: "oc_events",
  title: "Page session events",
  description: "Page through the bridge's event buffer after a cursor (oldest first): status changes, questions, permission requests, messages, todos, errors and inbox messages.",
  input: {
    cursor: cursorSchema.optional().describe("Events after this cursor. Default: the oldest buffered event."),
    sessionID: sessionIdSchema.optional(),
    limit: z.number().int().min(1).max(MAX_EVENTS).optional().describe(`Default 50, at most ${MAX_EVENTS}.`),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const box = args.sessionID ? await checkOwned(ctx, [args.sessionID], correlationId) : await ctx.box()
    const page = box.hub.events(parseCursor(args.cursor), args.sessionID ? { sessionID: args.sessionID } : undefined, args.limit ?? 50)
    if (page.expired)
      return ok("That cursor has expired (the sandbox restarted or the buffer moved on). Call oc_status, then page again without a cursor.", { expired: true, events: [], next: formatCursor(page.next) })
    return ok(`${page.events.length} event${page.events.length === 1 ? "" : "s"}.`, { expired: false, events: page.events.map(shapeEvent), next: formatCursor(page.next) })
  },
})
