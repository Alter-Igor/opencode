import { isSessionDeleting, markSessionDeleting, unmarkSessionDeleting } from "./cancel-tree.js"

const deletingSessions = new Map<string, number>()

export function beginDeletingSession(sessionID: string): () => void {
  deletingSessions.set(sessionID, (deletingSessions.get(sessionID) ?? 0) + 1)
  markSessionDeleting(sessionID)
  let released = false
  return () => {
    if (released) return
    released = true
    const next = (deletingSessions.get(sessionID) ?? 1) - 1
    if (next <= 0) {
      deletingSessions.delete(sessionID)
    } else deletingSessions.set(sessionID, next)
  }
}

export function isDeletingInFlight(sessionID: string | undefined): boolean {
  if (!sessionID) return false
  return (deletingSessions.get(sessionID) ?? 0) > 0
}

export function isDeletingSession(sessionID: string | undefined): boolean {
  if (!sessionID) return false
  return (deletingSessions.get(sessionID) ?? 0) > 0 || isSessionDeleting(sessionID)
}

export { unmarkSessionDeleting }
