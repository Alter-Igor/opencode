// MOD-05 → MOD-03: turn new messages in this bridge's supervisor inbox into `inbox` hub events, so
// oc_wait until:["message"], the watch CLI and the channel push see them. The inbox has no push
// route, so the bridge polls it (default every 5 s).
//
// Rules: each message is published at most once (cursor + a bounded seen-set); messages older
// than the poller's start are history, not news (oc_inbox still shows them); a failed read is
// logged and retried with backoff — it never publishes anything, and never a made-up event.
// Wiring (server owner): after ctx.box() resolves, `const stop = startInboxPoller(ctx, box.hub)`;
// call stop() on shutdown.
import type { DelegateHub } from "./events/index.ts"
import { realTimers, type Timers } from "./events/timers.ts"
import type { InboxMessage } from "./shared/contracts.ts"
import { isDelegateError } from "./shared/errors.ts"
import { safeLog } from "./shared/log.ts"
import type { ToolContext } from "./tools/context.ts"

export type InboxPollerOptions = {
  /** Poll interval while healthy. Default 5000 ms. */
  intervalMs?: number
  /** Longest wait between retries after failures. Default 60000 ms. */
  maxBackoffMs?: number
  /** Messages stamped before this (ms since epoch) are history. Default: when the poller starts. */
  since?: number
  timers?: Timers
}

export const DEFAULT_POLL_MS = 5_000
export const MAX_BACKOFF_MS = 60_000
/** Clock difference allowed between the host and the inbox container. */
export const CLOCK_SLACK_MS = 5_000
const PAGE_LIMIT = 100
const MAX_PAGES_PER_TICK = 10
const SEEN_CAP = 2_000

class SeenIds {
  private readonly ids = new Set<string>()
  has(id: string): boolean {
    return this.ids.has(id)
  }
  add(id: string): void {
    this.ids.add(id)
    if (this.ids.size > SEEN_CAP) {
      const oldest = this.ids.values().next().value
      if (oldest !== undefined) this.ids.delete(oldest)
    }
  }
  clear(): void {
    this.ids.clear()
  }
}

class InboxPoller {
  private readonly timers: Timers
  private readonly interval: number
  private readonly maxBackoff: number
  private readonly seen = new SeenIds()
  private cursor: string | undefined
  private since: number
  private failures = 0
  private stopped = false
  private cancel: () => void = () => {}

  constructor(
    private readonly ctx: Pick<ToolContext, "inbox" | "log">,
    private readonly hub: Pick<DelegateHub, "publishInbox">,
    options: InboxPollerOptions,
  ) {
    this.timers = options.timers ?? realTimers
    this.interval = options.intervalMs ?? DEFAULT_POLL_MS
    this.maxBackoff = options.maxBackoffMs ?? MAX_BACKOFF_MS
    this.since = options.since ?? this.timers.now()
  }

  start(): void {
    this.cancel = this.timers.setTimeout(() => void this.tick(), 0)
  }

  stop(): void {
    this.stopped = true
    this.cancel()
  }

  private isNews(message: InboxMessage): boolean {
    if (this.seen.has(message.id)) return false
    const at = Date.parse(message.at)
    return Number.isNaN(at) || at >= this.since - CLOCK_SLACK_MS
  }

  private async drain(): Promise<void> {
    for (let page = 0; page < MAX_PAGES_PER_TICK && !this.stopped; page++) {
      const result = await this.ctx.inbox.read(this.cursor, PAGE_LIMIT)
      if (result.truncated) safeLog(this.ctx.log, "warn", "inbox", "inbox retention dropped unread messages", { dropped: true })
      for (const message of result.messages) {
        if (!this.isNews(message)) continue
        this.seen.add(message.id)
        this.hub.publishInbox(message)
      }
      this.cursor = result.next
      if (result.messages.length < PAGE_LIMIT) return
    }
  }

  private onFailure(error: unknown): void {
    if (isDelegateError(error) && error.code === "cursor_expired") {
      // The inbox was reset (new epoch): start again from its oldest message, news only from now.
      this.cursor = undefined
      this.since = this.timers.now()
      this.seen.clear()
      safeLog(this.ctx.log, "warn", "inbox", "inbox cursor expired; restarting from the oldest message", {})
      return
    }
    this.failures++
    safeLog(this.ctx.log, "warn", "inbox", "inbox poll failed; will retry", { code: isDelegateError(error) ? error.code : "unexpected", failures: this.failures })
  }

  private delay(): number {
    return this.failures === 0 ? this.interval : Math.min(this.interval * 2 ** this.failures, this.maxBackoff)
  }

  private async tick(): Promise<void> {
    try {
      await this.drain()
      this.failures = 0
    } catch (error) {
      this.onFailure(error)
    }
    if (!this.stopped) this.cancel = this.timers.setTimeout(() => void this.tick(), this.delay())
  }
}

/** Start polling this bridge's supervisor inbox into `hub`. Returns stop. */
export function startInboxPoller(ctx: Pick<ToolContext, "inbox" | "log">, hub: Pick<DelegateHub, "publishInbox">, options: InboxPollerOptions = {}): () => void {
  const poller = new InboxPoller(ctx, hub, options)
  poller.start()
  return () => poller.stop()
}
