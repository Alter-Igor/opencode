// FEAT-OCD-001 MOD-05: sliding-window rate limits and a sampler for refusal log lines.
// Keys that have been quiet for a full window are dropped by prune(), which the server runs on a
// timer (W2C-09). The number of tracked keys is also hard-capped: a NEW key past the cap is
// refused, so made-up sender ids cannot grow memory without bound.

export const WINDOW_MS = 60_000

export type Take = "ok" | "limited" | "full"

export class RateLimiter {
  readonly #perWindow: number
  readonly #maxKeys: number
  readonly #now: () => number
  readonly #hits = new Map<string, number[]>()

  constructor(perWindow: number, now: () => number = Date.now, maxKeys = Number.POSITIVE_INFINITY) {
    this.#perWindow = perWindow
    this.#now = now
    this.#maxKeys = maxKeys
  }

  /** Record one attempt for `key`: "limited" when it used its allowance, "full" when too many keys are tracked. */
  take(key: string): Take {
    const now = this.#now()
    if (!this.#hits.has(key) && this.#hits.size >= this.#maxKeys) {
      this.prune()
      if (this.#hits.size >= this.#maxKeys) return "full"
    }
    const recent = (this.#hits.get(key) ?? []).filter((at) => now - at < WINDOW_MS)
    if (recent.length >= this.#perWindow) {
      this.#hits.set(key, recent)
      return "limited"
    }
    recent.push(now)
    this.#hits.set(key, recent)
    return "ok"
  }

  /** Drop keys with no attempt inside the window. */
  prune(): void {
    const now = this.#now()
    for (const [key, hits] of this.#hits) if (hits.every((at) => now - at >= WINDOW_MS)) this.#hits.delete(key)
  }

  get size(): number {
    return this.#hits.size
  }
}

/**
 * Lets at most `perWindow` refusal log lines through per window (W2C-06), so a flood of bad
 * requests cannot fill the disk through the log. The rest are counted; `flush()` reports how many
 * were dropped (the server calls it on its prune timer and before the next allowed line).
 */
export class LogSampler {
  readonly #perWindow: number
  readonly #now: () => number
  #windowStart = Number.NEGATIVE_INFINITY
  #used = 0
  #suppressed = 0

  constructor(perWindow: number, now: () => number = Date.now) {
    this.#perWindow = perWindow
    this.#now = now
  }

  /** True when this line may be logged. */
  allow(): boolean {
    const now = this.#now()
    if (now - this.#windowStart >= WINDOW_MS) {
      this.#windowStart = now
      this.#used = 0
    }
    if (this.#used >= this.#perWindow) {
      this.#suppressed++
      return false
    }
    this.#used++
    return true
  }

  /** How many lines were dropped since the last flush (and reset the count). */
  flush(): number {
    const dropped = this.#suppressed
    this.#suppressed = 0
    return dropped
  }
}
