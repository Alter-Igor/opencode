// T3.5 optional Claude channel push (research preview; off by default, --channels to turn on).
// A channel is an MCP server that declares the experimental capability `claude/channel` and sends
// `notifications/claude/channel` with {content: string, meta?: Record<string, string>}; Claude Code
// shows each one to the model as a <channel source="…" key="value">content</channel> tag
// (code.claude.com/docs/en/channels-reference, read 2026-10-01). Meta keys must be identifiers
// (letters, digits, underscore) or Claude Code drops them.
//
// What is pushed: a session became idle, needs input, hit an error or did not start, and a new
// inbox message arrived. `content` is one line written by the bridge from states and ids that
// match IDENT_RE; session text and box-supplied names are NEVER put in it (the client reads those
// with oc_result / oc_pending / oc_inbox, where they sit under `untrusted`).
// Pushes are coalesced: at most one notification per `intervalMs` (default 1 s).
//
// Wiring (server owner), in this order:
//   const server = new McpServer({ name, version }, { instructions: CHANNEL_INSTRUCTIONS … })
//   if (channels) declareChannelCapability(server)   // BEFORE server.connect(): the SDK refuses later
//   await server.connect(transport)
//   … once the hub exists (after ctx.box()): const detach = attachChannels(server, box.hub, { enabled: channels, log })
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { IDENT_RE, type DelegateHub } from "./events/index.ts"
import { realTimers, type Timers } from "./events/timers.ts"
import type { HubEvent, SessionState } from "./shared/contracts.ts"
import { safeLog, silentLogger, type Logger } from "./shared/log.ts"

export type ChannelOptions = {
  enabled: boolean
  /** Least time between two notifications; events in between are coalesced. Default 1000 ms. */
  intervalMs?: number
  /** Most updates listed in one coalesced notification. Default 10. */
  maxLines?: number
  timers?: Timers
  log?: Logger
}

export const CHANNEL_CAPABILITY = "claude/channel"
export const CHANNEL_METHOD = "notifications/claude/channel"
export const DEFAULT_CHANNEL_INTERVAL_MS = 1_000

/** Suggested MCP `instructions` text for a server started with channels on. */
export const CHANNEL_INSTRUCTIONS =
  'Updates from opencode-delegate arrive as <channel source="opencode-delegate" type="…" sessionID="…" state="…">. ' +
  "They are one-line notices written by the bridge. Act on them with the bridge tools: oc_result for idle sessions, " +
  "oc_pending then oc_answer for needs_input, oc_status for errors, oc_inbox for inbox messages. No reply to the channel is expected."

/** Declare the channel capability. Must run before server.connect() (the SDK throws afterwards). */
export function declareChannelCapability(server: McpServer): void {
  server.server.registerCapabilities({ experimental: { [CHANNEL_CAPABILITY]: {} } })
}

export type Notice = { key: string; line: string; meta: Record<string, string> }

const PUSHED: ReadonlySet<SessionState> = new Set<SessionState>(["idle", "needs_input", "error", "not_started"])

function lineFor(state: SessionState, id: string): string {
  switch (state) {
    case "idle":
      return `session ${id} is idle (finished its turn): read it with oc_result`
    case "needs_input":
      return `session ${id} is waiting for an answer: see oc_pending, answer with oc_answer`
    case "error":
      return `session ${id} stopped with an error: see oc_status`
    default:
      return `session ${id} did not start after a send: see oc_status`
  }
}

function withIdent(meta: Record<string, string>, key: string, value: string | undefined): void {
  if (value !== undefined && IDENT_RE.test(value)) meta[key] = value
}

/** The notice for one hub event, or undefined when it is not pushed. Uses no session text. */
export function channelNotice(event: HubEvent): Notice | undefined {
  if (event.type === "inbox") return { key: "inbox", line: "new message in this bridge's inbox: read it with oc_inbox", meta: { type: "inbox" } }
  if (!event.state || !PUSHED.has(event.state) || !event.sessionID || !IDENT_RE.test(event.sessionID)) return undefined
  // A subagent's own idle/error is noise: its parent reports the outcome. Its questions are not.
  if (event.parentID !== undefined && event.state !== "needs_input") return undefined
  const meta: Record<string, string> = { type: event.type, state: event.state }
  withIdent(meta, "sessionID", event.sessionID)
  withIdent(meta, "requestID", event.requestID)
  withIdent(meta, "parentID", event.parentID)
  return { key: `${event.sessionID}:${event.state}`, line: lineFor(event.state, event.sessionID), meta }
}

/** One notification from the notices of one window (latest per key, in first-seen order). */
export function coalesce(notices: Notice[], maxLines: number): { content: string; meta: Record<string, string> } {
  const [first] = notices
  if (notices.length === 1 && first) return { content: `opencode-delegate: ${first.line}`, meta: first.meta }
  const lines = notices.slice(0, maxLines).map((n) => n.line)
  const more = notices.length - lines.length
  const tail = more > 0 ? `; and ${more} more (see oc_events)` : ""
  return { content: `opencode-delegate: ${notices.length} updates: ${lines.join("; ")}${tail}`, meta: { type: "batch", count: String(notices.length) } }
}

type Pusher = { add(notice: Notice): void; stop(): void }

function pusher(server: McpServer, options: ChannelOptions): Pusher {
  const timers = options.timers ?? realTimers
  const interval = options.intervalMs ?? DEFAULT_CHANNEL_INTERVAL_MS
  const maxLines = options.maxLines ?? 10
  const log = options.log ?? silentLogger
  const pending = new Map<string, Notice>()
  let lastSent = Number.NEGATIVE_INFINITY
  let cancel: (() => void) | undefined
  let stopped = false

  const flush = (): void => {
    cancel = undefined
    if (stopped || pending.size === 0) return
    const params = coalesce([...pending.values()], maxLines)
    pending.clear()
    lastSent = timers.now()
    server.server.notification({ method: CHANNEL_METHOD, params }).catch((error: unknown) => {
      safeLog(log, "warn", "channel", "channel notification not sent", { error: error instanceof Error ? error.name : "unknown" })
    })
  }

  return {
    add(notice) {
      if (stopped) return
      pending.delete(notice.key) // latest wins, and moves to the end
      pending.set(notice.key, notice)
      if (cancel) return
      const wait = Math.max(0, lastSent + interval - timers.now())
      if (wait === 0) flush()
      else cancel = timers.setTimeout(flush, wait)
    },
    stop() {
      stopped = true
      cancel?.()
      pending.clear()
    },
  }
}

/** Push hub updates as Claude channel notifications. Returns a function that stops it. */
export function attachChannels(server: McpServer, hub: DelegateHub, options: ChannelOptions): () => void {
  if (!options.enabled) return () => {}
  const push = pusher(server, options)
  const unsubscribe = hub.subscribe((event) => {
    const notice = channelNotice(event)
    if (notice) push.add(notice)
  })
  return () => {
    unsubscribe()
    push.stop()
  }
}
