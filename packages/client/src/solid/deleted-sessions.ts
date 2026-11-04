// Fork (#176): the server deletes a session without stopping a reply that is still running, and
// it publishes message and part events before it writes them. Late events for a deleted session
// would re-create its store entries in sync.tsx after `session.deleted` freed them (#173), and a
// `sync()` still fetching would write the session back. A deleted ID does not come back in normal
// use (fork makes new IDs; there is no undo), so a small set of deleted IDs is enough to ignore
// them. Not covered: `opencode import` of a session deleted in the same TUI run keeps its old ID,
// so that TUI shows it empty until restart.

/** How many deleted session IDs are remembered; the oldest is forgotten first. */
const LIMIT = 200

type SessionEvent = { type: string; properties?: unknown }

/** The session an event writes to, for the event types sync.tsx keys by session. */
export function eventSessionID(event: SessionEvent): string | undefined {
  const properties = event.properties as
    | { sessionID?: unknown; info?: { id?: unknown; sessionID?: unknown }; part?: { sessionID?: unknown } }
    | undefined
  if (!properties || typeof properties !== "object") return undefined
  if (typeof properties.sessionID === "string") return properties.sessionID
  // message.updated carries the message in `info`; session.updated carries the session itself.
  if (typeof properties.info?.sessionID === "string") return properties.info.sessionID
  if (event.type.startsWith("session.") && typeof properties.info?.id === "string") return properties.info.id
  if (typeof properties.part?.sessionID === "string") return properties.part.sessionID
  return undefined
}

export function createDeletedSessions(limit = LIMIT) {
  const ids = new Set<string>()
  return {
    add(id: string) {
      ids.delete(id)
      ids.add(id)
      if (ids.size <= limit) return
      const oldest = ids.values().next().value
      if (oldest !== undefined) ids.delete(oldest)
    },
    has(id: string) {
      return ids.has(id)
    },
    /** A fetched session list without deleted sessions (a list fetched before the delete). */
    filter<T extends { id: string }>(list: T[]): T[] {
      return ids.size === 0 ? list : list.filter((item) => !ids.has(item.id))
    },
    /** A fetched per-session map without deleted sessions' keys. */
    omit<T>(map: Record<string, T>): Record<string, T> {
      if (ids.size === 0) return map
      return Object.fromEntries(Object.entries(map).filter(([id]) => !ids.has(id)))
    },
    /** True when the event belongs to a deleted session and must not write to the store. */
    ignores(event: SessionEvent) {
      if (ids.size === 0 || event.type === "session.deleted") return false
      const id = eventSessionID(event)
      return id !== undefined && ids.has(id)
    },
  }
}
