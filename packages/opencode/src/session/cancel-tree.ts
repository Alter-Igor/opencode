// Fork (#214): deleting a session did not stop a reply that was still running. Session.remove only
// cancels background jobs (it cannot reach SessionPrompt, which depends on it), so the run kept
// calling the model, running tools and publishing events for a session that no longer existed.
// The HTTP delete handler and workspace removal now cancel the session's run, and its child
// sessions' runs, first.
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

/**
 * The `isIdle` both callers use: idle only when the status says idle AND the runner is not busy. A
 * reply that just started has a busy runner before it sets its status (QA on #214).
 */
export const idleWhenQuiet =
  <ID, E>(status: (sessionID: ID) => Effect.Effect<{ type: string }>, assertNotBusy: (sessionID: ID) => Effect.Effect<void, E>) =>
  (sessionID: ID): Effect.Effect<boolean> =>
    status(sessionID).pipe(
      Effect.flatMap((info) =>
        info.type !== "idle"
          ? Effect.succeed(false)
          : assertNotBusy(sessionID).pipe(
              Effect.as(true),
              Effect.catchCause(() => Effect.succeed(false)),
            ),
      ),
    )

/** Cancel a session's run, then every descendant's, before the tree is removed. Idle ones are skipped. */
export const cancelSessionTree = <ID>(deps: CancelTreeDeps<ID>, sessionID: ID): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!(yield* deps.isIdle(sessionID))) yield* deps.cancel(sessionID)
    for (const child of yield* deps.children(sessionID)) yield* cancelSessionTree(deps, child.id)
  })
