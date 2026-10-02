// #72 review cycle 1 (MEDIUM 5): a per-session close lock. While oc_close_session or oc_cleanup
// closes a session, every tool that goes through ownSession (oc_send, oc_collect, oc_result,
// oc_abort, ...) refuses it with session_active, and a second close is refused too. The lock is
// held per bridge process (keyed by its session map), which is the only writer of its sessions.
import { DelegateError } from "../shared/errors.ts"
import type { ToolContext } from "./context.ts"

type Holder = Pick<ToolContext, "sessions">

const registry = new WeakMap<object, Set<string>>()

function closingSet(ctx: Holder): Set<string> {
  let set = registry.get(ctx.sessions)
  if (!set) {
    set = new Set()
    registry.set(ctx.sessions, set)
  }
  return set
}

export function isClosing(ctx: Holder, sessionID: string): boolean {
  return registry.get(ctx.sessions)?.has(sessionID) === true
}

export function closingError(sessionID: string): DelegateError {
  return new DelegateError("session_active", `Session ${sessionID} is being closed.`, "Wait for the close to finish, then check oc_list_sessions.")
}

/** Run `fn` holding the close lock for `sessionID`; refused when another close holds it. */
export async function whileClosing<T>(ctx: Holder, sessionID: string, fn: () => Promise<T>): Promise<T> {
  const set = closingSet(ctx)
  if (set.has(sessionID)) throw closingError(sessionID)
  set.add(sessionID)
  try {
    return await fn()
  } finally {
    set.delete(sessionID)
  }
}
