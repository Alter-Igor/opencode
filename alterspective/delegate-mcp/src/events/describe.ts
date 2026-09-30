// MOD-03: HubEvent construction. `summary` is one line built only from bridge words, counts,
// states and identifiers matching IDENT_RE (review W2C-03). Box-supplied names (tool/permission
// names outside OpenCode's built-ins, error names outside OpenCode's own, MCP server names) and
// session text go to `untrusted` only. The session text the hub carries is the final assistant
// text part (and inbox text), in `untrusted`, ≤500 chars.
import type { HubEvent, InboxMessage } from "../shared/contracts.ts"
import { scrub } from "../shared/log.ts"
import type { HubEventInput } from "./buffer.ts"
import type { Raw } from "./normalise.ts"
import type { Change, Derived, Link } from "./state.ts"

export const UNTRUSTED_MAX = 500
/** The only non-bridge text a summary may hold. */
export const IDENT_RE = /^[A-Za-z0-9_.:-]{1,40}$/

/** OpenCode's own error names (session/message-error.ts, NamedError.Unknown). */
const KNOWN_ERRORS = new Set(["APIError", "ContentFilterError", "ContextOverflowError", "MessageAbortedError", "MessageOutputLengthError", "ProviderAuthError", "StructuredOutputError", "UnknownError"])
/** OpenCode's built-in permission names (tool/*, agent/*). Anything else can be box-supplied (MCP tools). */
const KNOWN_PERMISSIONS = new Set(["bash", "codesearch", "doom_loop", "edit", "external_directory", "glob", "grep", "list", "lsp", "question", "read", "skill", "task", "todoread", "todowrite", "webfetch", "websearch", "workflow_tool_approval", "write"])

/** An identifier for a summary, or a fixed placeholder when it is not one. */
export function ident(value: string): string {
  return IDENT_RE.test(value) ? value : "(invalid id)"
}

export function errorLabel(name: string): string {
  return KNOWN_ERRORS.has(name) ? name : "unrecognised error"
}

function permissionLabel(name: string): string {
  return KNOWN_PERMISSIONS.has(name) ? name : "a tool"
}

/** Keep a bridge-built detail to a safe one-line charset and length (used for details and logs). */
export function safe(value: string, max = 60): string {
  const cleaned = value.replace(/[^A-Za-z0-9 _.,:;/@*()-]/g, "?")
  return cleaned.length > max ? cleaned.slice(0, max) + "…" : cleaned
}

type Base = { sessionID: string; directory: string; state: Derived; parentID?: string }

const stateOf = (state: Derived): HubEvent["state"] => (state === "unresolved" ? undefined : state)

function withParent<T extends HubEventInput>(event: T, parentID: string | undefined): T {
  if (parentID) event.parentID = parentID
  return event
}

export function statusEvent(change: Change, cause?: string): HubEventInput {
  const detail = change.detail ? ` (${safe(change.detail, 120)})` : ""
  const why = cause ? ` after ${cause}` : ""
  const event: HubEventInput = { type: "status", sessionID: change.sessionID, directory: change.directory, state: stateOf(change.state), summary: `session ${ident(change.sessionID)} is ${change.state}${detail}${why}` }
  return withParent(event, change.parentID)
}

type Specific = Extract<Raw, { kind: "error" | "permission.asked" | "question.asked" | "text.final" | "todo" }>

function specific(raw: Specific, id: string): Pick<HubEventInput, "type" | "summary" | "untrusted" | "requestID"> {
  switch (raw.kind) {
    case "error": {
      const label = errorLabel(raw.name)
      const named = label === raw.name ? {} : { untrusted: untrusted(`error name: ${raw.name}`) }
      return { type: "error", summary: raw.aborted ? `session ${id} was aborted` : `session ${id} reported an error: ${label}`, ...named }
    }
    case "permission.asked": {
      const patterns = `${raw.patterns} pattern${raw.patterns === 1 ? "" : "s"}`
      return { type: "permission", requestID: raw.requestID, summary: `session ${id} asks permission for ${permissionLabel(raw.permission)} (${patterns}); answer ${ident(raw.requestID)}`, untrusted: untrusted(`permission: ${raw.permission}`) }
    }
    case "question.asked":
      return { type: "question", requestID: raw.requestID, summary: `session ${id} asks ${raw.count} question${raw.count === 1 ? "" : "s"}; answer ${ident(raw.requestID)}` }
    case "text.final":
      return { type: "message", summary: `session ${id} wrote a reply (${raw.text.length} chars)`, untrusted: untrusted(raw.text) }
    case "todo":
      return { type: "todo", summary: `session ${id} todos: ${raw.done}/${raw.total} done` }
  }
}

/** Events for raw kinds that are news in themselves, whether or not the state changed. */
export function rawEvent(raw: Specific, base: Base): HubEventInput {
  const s = specific(raw, ident(base.sessionID))
  const carriesState = raw.kind === "error" || raw.kind === "permission.asked" || raw.kind === "question.asked"
  const event: HubEventInput = { sessionID: base.sessionID, directory: base.directory, ...s }
  if (carriesState) event.state = stateOf(base.state)
  return withParent(event, base.parentID)
}

export function mcpEvent(server: string, directory: string): HubEventInput {
  return { type: "mcp", directory, summary: "MCP tools changed for a server in a tracked directory", untrusted: untrusted(`server: ${server}`) }
}

export function resyncEvent(sessions: number): HubEventInput {
  return { type: "resync", summary: `event stream reconnected; state rebuilt from the server for ${sessions} session${sessions === 1 ? "" : "s"}` }
}

const LINK_WORDS: Record<Link["kind"], string> = { up: "connected", gap: "interrupted; session states are unknown until rebuilt", down: "cannot reach the server" }

/** Hub-level link change (no session, no state): the watch CLI prints it (W2A-11). */
export function linkEvent(link: Link): HubEventInput {
  const detail = link.kind === "up" ? "" : ` (${safe(link.detail, 120)})`
  return { type: "link", summary: `event stream ${LINK_WORDS[link.kind]}${detail}` }
}

/** An inbox message addressed to this bridge (MOD-05). Text and sender names stay untrusted. */
export function inboxEvent(message: InboxMessage): HubEventInput {
  const sender = message.verified ? `from ${ident(message.from)}` : `from ${ident(message.from)} (unverified sender)`
  return { type: "inbox", summary: `inbox message ${ident(message.id)} ${sender}`, untrusted: untrusted(message.text) }
}

/** Truncated and secret-scrubbed; commit ids survive. */
export function untrusted(text: string): string {
  const cut = text.length > UNTRUSTED_MAX ? text.slice(0, UNTRUSTED_MAX) + "…" : text
  return scrub(cut, { keepIds: true })
}

/** Bounded memory of assistant message ids and already-reported parts (reconnects repeat parts). */
export class MessageMemory {
  private readonly assistant = new Set<string>()
  private readonly reported = new Set<string>()

  constructor(private readonly cap = 2000) {}

  role(messageID: string, role: "user" | "assistant"): void {
    if (role === "assistant") add(this.assistant, messageID, this.cap)
  }

  /** True once per part, and only for parts of known assistant messages. */
  shouldReport(messageID: string, partID: string): boolean {
    if (!this.assistant.has(messageID) || this.reported.has(partID)) return false
    add(this.reported, partID, this.cap)
    return true
  }
}

function add(set: Set<string>, value: string, cap: number): void {
  set.add(value)
  if (set.size <= cap) return
  const oldest = set.values().next().value
  if (oldest !== undefined) set.delete(oldest)
}
