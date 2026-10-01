// WS2 (#48, review N2): on Windows a rename over a file another process has open (front's bind
// mount, another bridge reading the state) fails with EPERM / EBUSY / EACCES for a moment. Retry a
// few times with a short backoff (about 200 ms in all) before giving up.
import { rename } from "node:fs/promises"

export const RENAME_TRIES = 5
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"])

export type Rename = (from: string, to: string) => Promise<void>

export async function renameWithRetry(from: string, to: string, op: Rename = rename, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const error = await op(from, to).then(() => undefined, (e: unknown) => e as NodeJS.ErrnoException)
    if (error === undefined) return
    if (attempt >= RENAME_TRIES || !RETRYABLE.has(error.code ?? "")) throw error
    // 10, 20, 40, 80 ms: 150 ms of waiting over five tries.
    await sleep(10 * 2 ** (attempt - 1))
  }
}
