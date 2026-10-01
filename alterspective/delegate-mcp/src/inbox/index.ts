// FEAT-OCD-001 MOD-05: agent inbox, bridge side (technical-design.md §7).
// Wiring (hub): const cache = cachedTarget(() => inboxTargetFromDocker(exec, config));
//   createInbox({ supervisor: "supervisor:<name>", target: cache.target, invalidate: cache.invalidate })
// and set `metadata: { [SESSION_SUPERVISOR_KEY]: "supervisor:<name>" }` on POST /session so the
// in-box message_supervisor tool knows where to send.
export { DEFAULT_INBOX_TIMEOUT_MS, createInbox, mapFailure, parseCursor, toPage, type BridgeInbox, type InboxOptions, type InboxPage, type InboxTarget } from "./client.ts"
export { cachedTarget, inboxContainer, inboxTargetFromDocker } from "./target.ts"
export { displayText, senderTrust, wakeText } from "./wake.ts"

/** Session metadata key the in-box message_supervisor tool reads (profile-tools/inbox-lib.ts). */
export const SESSION_SUPERVISOR_KEY = "supervisor"
