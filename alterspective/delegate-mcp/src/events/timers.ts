// MOD-03: one injectable clock for the event hub, so tests drive time instead of waiting for it.
// Every timer the hub holds is cancellable, and stop() cancels them all.

export type Timers = {
  now(): number
  /** Run `fn` once after `ms`; returns a function that cancels it. */
  setTimeout(fn: () => void, ms: number): () => void
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  },
}

/** Sleep that ends early (without throwing) when `stop` aborts. */
export function sleep(timers: Timers, ms: number, stop?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (stop?.aborted) return resolve()
    let cancel = () => {}
    const done = () => {
      cancel()
      stop?.removeEventListener("abort", done)
      resolve()
    }
    cancel = timers.setTimeout(done, ms)
    stop?.addEventListener("abort", done, { once: true })
  })
}
