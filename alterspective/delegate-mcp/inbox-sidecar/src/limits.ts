// FEAT-OCD-001 MOD-05: sliding-window rate limit (per claimed sender, and one for the whole box
// route). Keys that have been quiet for a full window are dropped, so made-up sender ids cannot
// grow memory without bound.

const WINDOW_MS = 60_000
const PRUNE_ABOVE_KEYS = 1000

export class RateLimiter {
  readonly #perWindow: number
  readonly #now: () => number
  readonly #hits = new Map<string, number[]>()

  constructor(perWindow: number, now: () => number = Date.now) {
    this.#perWindow = perWindow
    this.#now = now
  }

  /** Record one attempt for `key`; false when the key already used its allowance this minute. */
  take(key: string): boolean {
    const now = this.#now()
    if (this.#hits.size > PRUNE_ABOVE_KEYS) this.#prune(now)
    const recent = (this.#hits.get(key) ?? []).filter((at) => now - at < WINDOW_MS)
    if (recent.length >= this.#perWindow) {
      this.#hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.#hits.set(key, recent)
    return true
  }

  #prune(now: number): void {
    for (const [key, hits] of this.#hits) if (hits.every((at) => now - at >= WINDOW_MS)) this.#hits.delete(key)
  }

  get size(): number {
    return this.#hits.size
  }
}
