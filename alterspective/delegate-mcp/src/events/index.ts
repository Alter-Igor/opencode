// MOD-03 public surface: the event hub (contracts.ts EventHub + subscribe/publish), and the
// pieces the tool surface and watch CLI reuse.
export { createHub, type DelegateHub, type HubOptions, type Listener } from "./hub.ts"
export { CAPACITY, DEFAULT_PAGE, MAX_PAGE, matchesUntil, type HubEventInput, type Page, type WaitInput, type WaitResult } from "./buffer.ts"
export { UNTRUSTED_MAX, safe } from "./describe.ts"
export { BACKOFF_MS, EVENT_PATH, STALE_MS, SseParser, runStream, type Drop } from "./sse.ts"
export { NOT_STARTED_MS, SENT_SLACK_MS, SessionTable } from "./state.ts"
export { readRemote, readSnapshot } from "./server.ts"
export { realTimers, type Timers } from "./timers.ts"
