// Fork (#214): the server can still publish events for a session after deleting it (a run that
// was stopping, a title job, events that race the delete). applyDirectoryEvent would re-create the
// session's list entry and caches from them. The TUI got the same guard in #176
// (packages/tui/src/context/deleted-sessions.ts). Here the reducer is a plain function, so the
// deleted IDs are kept per directory store.

/** How many deleted session IDs each store remembers; the oldest is forgotten first. */
const LIMIT = 200

const deletedByStore = new WeakMap<object, Set<string>>()

type SessionEvent = { type: string; properties?: unknown }

/** The session an event writes to, for the event types the reducer keys by session. */
export function eventSessionID(event: SessionEvent): string | undefined {
  const properties = event.properties as
    | { sessionID?: unknown; info?: { id?: unknown; sessionID?: unknown }; part?: { sessionID?: unknown } }
    | undefined
  if (!properties || typeof properties !== "object") return undefined
  if (typeof properties.sessionID === "string") return properties.sessionID
  if (typeof properties.info?.sessionID === "string") return properties.info.sessionID
  if (event.type.startsWith("session.") && typeof properties.info?.id === "string") return properties.info.id
  if (typeof properties.part?.sessionID === "string") return properties.part.sessionID
  return undefined
}

/** Remember that `sessionID` was deleted in this directory store. */
export function markSessionDeleted(store: object, sessionID: string) {
  let ids = deletedByStore.get(store)
  if (!ids) deletedByStore.set(store, (ids = new Set()))
  ids.delete(sessionID)
  ids.add(sessionID)
  if (ids.size <= LIMIT) return
  const oldest = ids.values().next().value
  if (oldest !== undefined) ids.delete(oldest)
}

/**
 * True when the event belongs to a session deleted in this store and must not write to it. A
 * `session.created` for a deleted ID (`opencode import` keeps IDs) brings the session back.
 */
export function isDeletedSessionEvent(store: object, event: SessionEvent): boolean {
  if (event.type === "session.deleted") return false
  const ids = deletedByStore.get(store)
  if (!ids || ids.size === 0) return false
  const id = eventSessionID(event)
  if (event.type === "session.created") {
    if (id !== undefined) ids.delete(id)
    return false
  }
  return id !== undefined && ids.has(id)
}
