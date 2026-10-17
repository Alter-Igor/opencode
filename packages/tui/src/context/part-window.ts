// Fork (#215): sync.tsx keeps a window of a session's latest messages (100 at load, trimmed as
// live messages arrive). A part event for a message outside that window, such as compaction
// pruning an old tool part, used to create `part[messageID]` for a message the store does not
// hold. Nothing freed it, not even `session.deleted`, which frees parts by the messages it lists.

/**
 * True when a part belongs to a message older than every message loaded for its session, so it
 * would only create an orphan. Message IDs ascend with creation (`MessageID.ascending`). A part
 * of a session with no loaded messages, or of a newer message, passes.
 */
export function outsideWindow(messages: ReadonlyArray<{ id: string }> | undefined, messageID: string): boolean {
  if (!messages || messages.length === 0) return false
  let oldest = messages[0]!.id
  for (const message of messages) {
    if (message.id === messageID) return false
    if (message.id < oldest) oldest = message.id
  }
  return messageID < oldest
}

/** Free every stored part of a session, including orphans of messages the store no longer lists. */
export function freeSessionParts(parts: Record<string, ReadonlyArray<{ sessionID?: string }> | undefined>, sessionID: string) {
  for (const [messageID, list] of Object.entries(parts)) {
    if (list?.some((part) => part.sessionID === sessionID)) delete parts[messageID]
  }
}
