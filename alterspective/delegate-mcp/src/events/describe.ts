// MOD-03: HubEvent construction. `summary` is one line built only from bridge-controlled values
// (ids, states, counts, sanitised names); text a session wrote never goes there. The only
// session text the hub carries is the final assistant text part, in `untrusted`, ≤500 chars.
import type { HubEvent } from "../shared/contracts.ts"
import { scrub } from "../shared/log.ts"
import type { HubEventInput } from "./buffer.ts"
import type { Raw } from "./normalise.ts"
import type { Change, Derived } from "./state.ts"

export const UNTRUSTED_MAX = 500

/** Keep a name/id to a safe one-line charset and length (tool names and ids are box-supplied). */
export function safe(value: string, max = 60): string {
  const cleaned = value.replace(/[^A-Za-z0-9 _.,:;/@*()-]/g, "?")
  return cleaned.length > max ? cleaned.slice(0, max) + "…" : cleaned
}

type Base = { sessionID: string; directory: string; state: Derived }

const stateOf = (state: Derived): HubEvent["state"] => (state === "unresolved" ? undefined : state)

export function statusEvent(change: Change, cause?: string): HubEventInput {
  const detail = change.detail ? ` (${safe(change.detail, 120)})` : ""
  const why = cause ? ` after ${cause}` : ""
  return { type: "status", sessionID: change.sessionID, directory: change.directory, state: stateOf(change.state), summary: `session ${safe(change.sessionID)} is ${change.state}${detail}${why}` }
}

type Specific = Extract<Raw, { kind: "error" | "permission.asked" | "question.asked" | "text.final" | "todo" }>

/** Events for raw kinds that are news in themselves, whether or not the state changed. */
export function rawEvent(raw: Specific, base: Base): HubEventInput {
  const s = { sessionID: base.sessionID, directory: base.directory }
  const id = safe(base.sessionID)
  const state = stateOf(base.state)
  switch (raw.kind) {
    case "error":
      return { ...s, type: "error", state, summary: raw.aborted ? `session ${id} was aborted` : `session ${id} failed: ${safe(raw.name)}` }
    case "permission.asked":
      return { ...s, type: "permission", state, requestID: raw.requestID, summary: `session ${id} asks permission: ${safe(raw.permission)} (${raw.patterns} pattern${raw.patterns === 1 ? "" : "s"}); answer ${safe(raw.requestID)}` }
    case "question.asked":
      return { ...s, type: "question", state, requestID: raw.requestID, summary: `session ${id} asks ${raw.count} question${raw.count === 1 ? "" : "s"}; answer ${safe(raw.requestID)}` }
    case "text.final":
      return { ...s, type: "message", summary: `session ${id} wrote a reply (${raw.text.length} chars)`, untrusted: untrusted(raw.text) }
    case "todo":
      return { ...s, type: "todo", summary: `session ${id} todos: ${raw.done}/${raw.total} done` }
  }
}

export function mcpEvent(server: string, directory: string): HubEventInput {
  return { type: "mcp", directory, summary: `MCP tools changed for server ${safe(server)} in ${safe(directory, 120)}` }
}

export function resyncEvent(sessions: number): HubEventInput {
  return { type: "resync", summary: `event stream reconnected; state rebuilt from the server for ${sessions} session${sessions === 1 ? "" : "s"}` }
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
