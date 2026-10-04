// Fork-only (#100): the CLI subprocess slot pool in test/lib/cli-process.ts.
import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { cliConcurrency, cliSlotsForTest } from "./cli-process"

const { slot, waiting, active } = cliSlotsForTest

/** Holds every slot inside one scope, then runs `body`. */
const withAllSlotsHeld = <A>(body: Effect.Effect<A>) =>
  Effect.scoped(
    Effect.gen(function* () {
      for (let i = 0; i < cliConcurrency; i++) yield* slot
      expect(active()).toBe(cliConcurrency)
      return yield* body
    }),
  )

describe("CLI subprocess slots (#100)", () => {
  test("the limit is a positive whole number", () => {
    expect(Number.isSafeInteger(cliConcurrency)).toBe(true)
    expect(cliConcurrency).toBeGreaterThanOrEqual(1)
  })

  test("an interrupted waiter leaves the queue and never holds a slot", async () => {
    await Effect.runPromise(
      withAllSlotsHeld(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(Effect.scoped(slot))
          yield* Effect.yieldNow
          expect(waiting()).toBe(1)
          yield* Fiber.interrupt(fiber)
          expect(waiting()).toBe(0)
          expect(active()).toBe(cliConcurrency)
        }),
      ),
    )
    expect(active()).toBe(0)
  })

  test("a released slot goes to the next waiter", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          withAllSlotsHeld(
            Effect.gen(function* () {
              const waiter = yield* Effect.forkChild(Effect.scoped(Effect.map(slot, () => "got a slot")))
              yield* Effect.yieldNow
              expect(waiting()).toBe(1)
              return waiter
            }),
          ).pipe(Effect.flatMap(Fiber.join)),
        )
        expect(yield* Fiber.join(fiber)).toBe("got a slot")
      }),
    )
    expect(active()).toBe(0)
    expect(waiting()).toBe(0)
  })

  test("releasing twice frees one slot only", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* slot
          expect(active()).toBe(1)
          lease.release()
          lease.release()
          expect(active()).toBe(0)
        }),
      ),
    )
    expect(active()).toBe(0)
  })
})
