// Fork (#215): sync.tsx keeps a window of a session's latest messages (100 at load, trimmed as
// live messages arrive). A part event for a message outside that window, such as compaction
// pruning an old tool part, used to create `part[messageID]` for a message the store does not
// hold. Nothing freed it, not even `session.deleted`, which frees parts by the messages it lists.

/**
 * True when a part's message is not among the session's loaded messages. sync.tsx drops such a
 * part only for a session it has fully synced: the server publishes `message.updated` before that
 * message's parts, so in a synced session an unlisted message is one outside the window (trimmed,
 * never loaded, or removed). Message IDs are not compared: their 48-bit time wraps (QA on #215).
 */
export function unlistedMessage(messages: ReadonlyArray<{ id: string }> | undefined, messageID: string): boolean {
  return !!messages && !messages.some((message) => message.id === messageID)
}

/** Free every stored part of a session, including orphans of messages the store no longer lists. */
export function freeSessionParts(parts: Record<string, ReadonlyArray<{ sessionID?: string }> | undefined>, sessionID: string) {
  for (const [messageID, list] of Object.entries(parts)) {
    // Every part of one message shares its session, so the first one tells.
    if (list?.[0]?.sessionID === sessionID) delete parts[messageID]
  }
}
