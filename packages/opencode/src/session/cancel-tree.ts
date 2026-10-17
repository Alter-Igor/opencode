// Fork (#214): deleting a session did not stop a reply that was still running. Session.remove only
// cancels background jobs (it cannot reach SessionPrompt, which depends on it), so the run kept
// calling the model, running tools and publishing events for a session that no longer existed.
// The HTTP delete handler now cancels the session's run, and its child sessions' runs, first.
import { Effect } from "effect"

export type CancelTreeDeps<ID> = {
  /** Cancel one session's run; a no-op (status idle) when nothing runs. */
  readonly cancel: (sessionID: ID) => Effect.Effect<void>
  readonly children: (parentID: ID) => Effect.Effect<ReadonlyArray<{ id: ID }>>
}

/** Cancel a session's run, then every descendant's, before the tree is removed. */
export const cancelSessionTree = <ID>(deps: CancelTreeDeps<ID>, sessionID: ID): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* deps.cancel(sessionID)
    for (const child of yield* deps.children(sessionID)) yield* cancelSessionTree(deps, child.id)
  })
