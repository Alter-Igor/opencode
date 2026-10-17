// Fork (#214): deleting a session did not stop a reply that was still running. Session.remove only
// cancels background jobs (it cannot reach SessionPrompt, which depends on it), so the run kept
// calling the model, running tools and publishing events for a session that no longer existed.
// The HTTP delete handler now cancels the session's run, and its child sessions' runs, first.
import { Effect } from "effect"

export type CancelTreeDeps<ID> = {
  /** Cancel one session's run and wait for it to stop. */
  readonly cancel: (sessionID: ID) => Effect.Effect<void>
  /**
   * True when the session runs nothing (status idle and no busy runner). Such a session is not cancelled: cancel would publish
   * `session.status` / `session.idle` for it, and an idle event on a session being deleted wakes
   * idle listeners (the observer's retrospective, the goal loop) for nothing (architect on #214).
   */
  readonly isIdle: (sessionID: ID) => Effect.Effect<boolean>
  readonly children: (parentID: ID) => Effect.Effect<ReadonlyArray<{ id: ID }>>
}

/** Cancel a session's run, then every descendant's, before the tree is removed. Idle ones are skipped. */
export const cancelSessionTree = <ID>(deps: CancelTreeDeps<ID>, sessionID: ID): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!(yield* deps.isIdle(sessionID))) yield* deps.cancel(sessionID)
    for (const child of yield* deps.children(sessionID)) yield* cancelSessionTree(deps, child.id)
  })
