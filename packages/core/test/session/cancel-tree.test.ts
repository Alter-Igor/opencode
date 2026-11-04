// Fork (#214): deleting a session cancels its run and every descendant's run first.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { cancelSessionTree, idleWhenQuiet } from "../../src/session/cancel-tree"

describe("cancelSessionTree (#214)", () => {
  test("cancels the session, then each child and grandchild, once each", async () => {
    const tree: Record<string, string[]> = { root: ["a", "b"], a: ["a1"], b: [], a1: [] }
    const cancelled: string[] = []
    await Effect.runPromise(
      cancelSessionTree(
        {
          cancel: (id: string) => Effect.sync(() => void cancelled.push(id)),
          children: (id: string) => Effect.succeed((tree[id] ?? []).map((child) => ({ id: child }))),
          isIdle: () => Effect.succeed(false),
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
        { cancel: (id: string) => Effect.sync(() => void cancelled.push(id)), children: () => Effect.succeed([]), isIdle: () => Effect.succeed(false) },
        "solo",
      ),
    )
    expect(cancelled).toEqual(["solo"])
  })

  test("an idle session is not cancelled, but its children are still walked (architect on #214)", async () => {
    const tree: Record<string, string[]> = { root: ["busy", "quiet"], busy: [], quiet: ["deep"], deep: [] }
    const running = new Set(["busy", "deep"])
    const cancelled: string[] = []
    await Effect.runPromise(
      cancelSessionTree(
        {
          cancel: (id: string) => Effect.sync(() => void cancelled.push(id)),
          children: (id: string) => Effect.succeed((tree[id] ?? []).map((child) => ({ id: child }))),
          isIdle: (id: string) => Effect.succeed(!running.has(id)),
        },
        "root",
      ),
    )
    expect(cancelled).toEqual(["busy", "deep"])
  })

  test("Session.remove cancels the tree before it awaits idle and removes children", async () => {
    const source = await Bun.file(new URL("../../src/session.ts", import.meta.url)).text()
    const cancel = source.indexOf("cancelSessionTree(")
    expect(cancel).toBeGreaterThan(-1)
    expect(cancel).toBeLessThan(source.indexOf("execution.awaitIdle(sessionID)"))
  })

  test("idleWhenQuiet: idle only when the status is idle and the runner is not busy", async () => {
    const check = (status: string, busy: boolean) =>
      Effect.runPromise(
        idleWhenQuiet(
          () => Effect.succeed({ type: status }),
          () => (busy ? Effect.fail("busy") : Effect.void),
        )("s1"),
      )
    expect(await check("idle", false)).toBe(true)
    expect(await check("busy", false)).toBe(false)
    expect(await check("retry", false)).toBe(false)
    // A reply that just started: the runner is busy before the status says so.
    expect(await check("idle", true)).toBe(false)
  })

  test("Session.remove walks descendant sessions recursively when removing a root session (#214)", async () => {
    const source = await Bun.file(new URL("../../src/session.ts", import.meta.url)).text()
    const cancel = source.indexOf("cancelSessionTree(")
    expect(cancel).toBeGreaterThan(-1)
    expect(cancel).toBeLessThan(source.indexOf("result.remove(child.id)"))
  })
})
