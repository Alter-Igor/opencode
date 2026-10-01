// WS2 (#48, review N2): a rename over a file another process holds open on Windows (EPERM, EBUSY,
// EACCES) is retried a few times with a short backoff; anything else fails at once.
import { describe, expect, test } from "bun:test"
import { RENAME_TRIES, renameWithRetry } from "../src/synapse/fs-retry.ts"

const fail = (code: string) => Object.assign(new Error(code), { code })
const noSleep = async () => {}

describe("renameWithRetry", () => {
  test("an injected EPERM twice, then success", async () => {
    let calls = 0
    await renameWithRetry("a", "b", async () => {
      if (++calls <= 2) throw fail("EPERM")
    }, noSleep)
    expect(calls).toBe(3)
  })

  test("EBUSY / EACCES that never clear: gives up after the last try with the error", async () => {
    for (const code of ["EBUSY", "EACCES"]) {
      let calls = 0
      const waits: number[] = []
      const result = renameWithRetry("a", "b", async () => ((calls++, Promise.reject(fail(code))) as Promise<void>), async (ms) => void waits.push(ms))
      expect(result).rejects.toThrow(code)
      await result.catch(() => {})
      expect(calls).toBe(RENAME_TRIES)
      expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(200)
    }
  })

  test("other errors are not retried", async () => {
    let calls = 0
    await renameWithRetry("a", "b", async () => ((calls++, Promise.reject(fail("ENOENT"))) as Promise<void>), noSleep).catch(() => {})
    expect(calls).toBe(1)
  })
})
