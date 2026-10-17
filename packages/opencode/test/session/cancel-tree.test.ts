// Fork (#214): deleting a session cancels its run and every descendant's run first.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { cancelSessionTree } from "../../src/session/cancel-tree"

describe("cancelSessionTree (#214)", () => {
  test("cancels the session, then each child and grandchild, once each", async () => {
    const tree: Record<string, string[]> = { root: ["a", "b"], a: ["a1"], b: [], a1: [] }
    const cancelled: string[] = []
    await Effect.runPromise(
      cancelSessionTree(
        {
          cancel: (id: string) => Effect.sync(() => void cancelled.push(id)),
          children: (id: string) => Effect.succeed((tree[id] ?? []).map((child) => ({ id: child }))),
        },
        "root",
      ),
    )
    expect(cancelled).toEqual(["root", "a", "a1", "b"])
  })

  test("a session with no children cancels only itself", async () => {
    const cancelled: string[] = []
    await Effect.runPromise(
      cancelSessionTree(
        { cancel: (id: string) => Effect.sync(() => void cancelled.push(id)), children: () => Effect.succeed([]) },
        "solo",
      ),
    )
    expect(cancelled).toEqual(["solo"])
  })

  test("the session delete handler cancels the tree before it removes the session", async () => {
    const source = await Bun.file(new URL("../../src/server/routes/instance/httpapi/handlers/session.ts", import.meta.url)).text()
    const cancel = source.indexOf("cancelSessionTree(")
    expect(cancel).toBeGreaterThan(-1)
    expect(cancel).toBeLessThan(source.indexOf("session.remove(ctx.params.sessionID)"))
  })
})
