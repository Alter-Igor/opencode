// #67 step 1: run an async step and get its outcome as a value instead of a throw, so the token
// manager can decide on a failure (keep the token, retry, fail closed) with plain async/await
// (CODING-STANDARDS: no promise chains). The error is kept for classification, never logged raw.
export type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown }

/**
 * Await `fn` and report whether it succeeded.
 *
 * @param fn the async step
 * @returns `{ ok: true, value }` or `{ ok: false, error }`
 * @throws never
 * @example const saved = await attempt(() => store.write(token))
 */
export async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error }
  }
}
