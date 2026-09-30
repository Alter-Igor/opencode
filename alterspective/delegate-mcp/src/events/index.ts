// MOD-03 public surface: the event hub (contracts.ts EventHub + subscribe/publishInbox), and the
// pieces the tool surface and watch CLI reuse.
export { createHub, type DelegateHub, type HubOptions, type Listener } from "./hub.ts"
export { CAPACITY, DEFAULT_PAGE, MAX_PAGE, matchesUntil, viewMatches, type HubEventInput, type Page, type WaitInput, type WaitResult } from "./buffer.ts"
export { IDENT_RE, UNTRUSTED_MAX, ident, safe } from "./describe.ts"
export { REQUEST_ID_RE } from "./normalise.ts"
export { BACKOFF_MS, EVENT_PATH, HEALTHY_MS, MAX_EVENT_CHARS, STALE_MS, SseParser, runStream, type Drop } from "./sse.ts"
export { AUTO_CAP, NOT_STARTED_MS, PRUNE_MS, SENT_SLACK_MS, SessionTable } from "./state.ts"
export { READ_CONCURRENCY, readRemote, readSnapshot } from "./server.ts"
export { realTimers, type Timers } from "./timers.ts"
