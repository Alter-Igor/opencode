// #190: the inbox store's atomic state save retries a rename that Windows refuses for a moment
// (antivirus or the indexer holding state.json open). Seen as EPERM in the full suite.
import { describe, expect, test } from "bun:test"
import { renameWithRetry, RENAME_RETRY_DELAYS_MS } from "../inbox-sidecar/src/store.ts"

const fsError = (code: string) => Object.assign(new Error(`${code}: rename`), { code })

describe("inbox store: renameWithRetry (#190)", () => {
  test("a rename refused for a moment (EPERM, EBUSY, EACCES) succeeds on a retry", () => {
    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
      let calls = 0
      const waits: number[] = []
      renameWithRetry("a.tmp", "a", {
        rename: () => {
          calls++
          if (calls < 3) throw fsError(code)
        },
        sleep: (ms) => waits.push(ms),
      })
      expect(calls).toBe(3)
      expect(waits).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 2))
    }
  })

  test("any other error is thrown at once, with no retry", () => {
    let calls = 0
    const run = () =>
      renameWithRetry("a.tmp", "a", {
        rename: () => {
          calls++
          throw fsError("ENOENT")
        },
        sleep: () => {},
      })
    expect(run).toThrow("ENOENT")
    expect(calls).toBe(1)
  })

  test("a lock that never clears throws the last error after every retry", () => {
    let calls = 0
    const waits: number[] = []
    const run = () =>
      renameWithRetry("a.tmp", "a", {
        rename: () => {
          calls++
          throw fsError("EPERM")
        },
        sleep: (ms) => waits.push(ms),
      })
    expect(run).toThrow("EPERM")
    expect(calls).toBe(RENAME_RETRY_DELAYS_MS.length + 1)
    expect(waits).toEqual([...RENAME_RETRY_DELAYS_MS])
  })

  test("the store's state save goes through the retry: a refused first rename still writes state.json", async () => {
    const { mkdtempSync, readFileSync, renameSync, rmSync } = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const { InboxStore } = await import("../inbox-sidecar/src/store.ts")
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocd-rename-store-"))
    try {
      let calls = 0
      // A new data folder starts a new epoch, which saves state.json once while opening.
      InboxStore.open({
        dir,
        renameFile: (from, to) => {
          calls++
          if (calls === 1) throw fsError("EPERM")
          renameSync(from, to)
        },
      })
      expect(calls).toBe(2)
      expect(JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).epoch).toMatch(/^[0-9a-f]{16}$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a plain rename on disk works with the default rename and sleep", async () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocd-rename-"))
    try {
      writeFileSync(path.join(dir, "s.json.tmp"), "new")
      writeFileSync(path.join(dir, "s.json"), "old")
      renameWithRetry(path.join(dir, "s.json.tmp"), path.join(dir, "s.json"))
      expect(readFileSync(path.join(dir, "s.json"), "utf8")).toBe("new")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
