// oc_wait and oc_events (technical-design §5, §6): long-poll and page the hub's event buffer.
// Event summaries are bridge words (contracts.ts HubEvent); anything the box supplied is only
// ever returned under `untrusted`.
import { z } from "zod"
import type { HubEvent, SessionView, WaitUntil } from "../shared/contracts.ts"
import type { Box, ToolContext } from "./context.ts"
import { cursorSchema, formatCursor, ownSession, parseCursor, sessionIdSchema } from "./core-session.ts"
import { defineTool } from "./define.ts"
import { ok, untrusted } from "./shape.ts"

export const MAX_WAIT_SEC = 240
/** W3A-11: under the common 120 s client tool timeout, with room for the reply. */
export const DEFAULT_WAIT_SEC = 100
export const MAX_EVENTS = 200
const DEFAULT_UNTIL: WaitUntil[] = ["idle", "needs_input", "error"]
/** States in which a session is still working, so "call again" is the right advice (W3A-03). */
const RUNNING = new Set(["busy", "retry", "starting"])

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

type WaitArgs = { sessionIDs: string[]; until?: WaitUntil[]; timeoutSec?: number; cursor?: string }

/** W3A-03: the hub this wait ran on was stopped or replaced (restart, reconnect, shutdown). */
async function hubChanged(ctx: ToolContext, args: WaitArgs) {
  const fresh = ctx.peekBox() ?? (await ctx.box().catch(() => undefined))
  const next = fresh ? formatCursor(fresh.hub.cursor()) : undefined
  const views = fresh ? await Promise.all(args.sessionIDs.map((id) => fresh.hub.view(id))) : []
  const summary = "The sandbox connection was replaced or stopped during the wait (restart or reconnect), so events may have been missed. Check oc_status, then call oc_wait again with the new cursor."
  return ok(summary, { still_running: false, hub_changed: true, ...(next ? { next } : {}), views })
}

function timedOut(timeoutSec: number, next: string, events: ReturnType<typeof shapeEvent>[], states: SessionView[]) {
  const running = states.some((v) => RUNNING.has(v.state))
  const list = states.map((v) => `${v.sessionID} ${v.state}`).join("; ")
  const advice = running ? " Still running: call oc_wait again with the next cursor." : " Check oc_status or oc_pending."
  return ok(`No matching state after ${timeoutSec} s: ${list}.${advice}`, { still_running: running, next, events, views: states })
}

async function waitOn(ctx: ToolContext, box: Box, args: WaitArgs) {
  const timeoutSec = args.timeoutSec ?? DEFAULT_WAIT_SEC
  const result = await box.hub.wait({ sessionIDs: args.sessionIDs, until: args.until ?? DEFAULT_UNTIL, timeoutMs: timeoutSec * 1000, cursor: parseCursor(args.cursor) })
  if (ctx.peekBox() !== box) return hubChanged(ctx, args)
  const page = capEvents(result.events, formatCursor(result.next), 100)
  if (result.timedOut) return timedOut(timeoutSec, page.next, page.events, await Promise.all(args.sessionIDs.map((id) => box.hub.view(id))))
  const views = result.views ?? []
  const matched = [...page.events.filter((e) => e.state).map((e) => `${e.sessionID ?? "?"} ${e.state}`), ...views.map((v) => `${v.sessionID} ${v.state}`)]
  return ok(`Done waiting: ${matched.join("; ") || "matching event"}.`, { still_running: false, next: page.next, events: page.events, views, ...(page.more ? { more: true } : {}) })
}

export const waitTool = defineTool({
  name: "oc_wait",
  title: "Wait for sessions",
  description:
    `Wait until any of the given sessions reaches one of the \`until\` states (default idle, needs_input, error) or the timeout passes (default ${DEFAULT_WAIT_SEC} s). Pass the cursor from oc_send so nothing that happened after the send is missed. ` +
    "On timeout the summary names each session's state; still_running:true means call again with the next cursor. hub_changed:true means the sandbox connection was replaced during the wait: use the new cursor.",
  input: {
    sessionIDs: z.array(sessionIdSchema).min(1).max(20),
    until: z.array(z.enum(["idle", "needs_input", "error", "message"])).min(1).optional(),
    timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).optional().describe(`Default ${DEFAULT_WAIT_SEC}, at most ${MAX_WAIT_SEC}.`),
    cursor: cursorSchema.optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const box = await checkOwned(ctx, args.sessionIDs, correlationId)
    return waitOn(ctx, box, args)
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
    const held = ctx.peekBox()
    // W3A-10: never starts the sandbox. Without a held box there is no event buffer to page.
    if (!held) return ok("No events: this bridge holds no sandbox connection yet.", { expired: false, events: [] })
    const box = args.sessionID ? await checkOwned(ctx, [args.sessionID], correlationId) : held
    const page = box.hub.events(parseCursor(args.cursor), args.sessionID ? { sessionID: args.sessionID } : undefined, args.limit ?? 50)
    if (page.expired)
      return ok("That cursor has expired (the sandbox restarted or the buffer moved on). Call oc_status, then page again without a cursor.", { expired: true, events: [], next: formatCursor(page.next) })
    return ok(`${page.events.length} event${page.events.length === 1 ? "" : "s"}.`, { expired: false, events: page.events.map(shapeEvent), next: formatCursor(page.next) })
  },
})
