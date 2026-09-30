// FEAT-OCD-001 MOD-05: the inbox's shared rules (technical-design.md §7).
// This folder is its own Docker build context, so nothing here imports from ../src.
// The bridge (src/inbox) and the in-box tools (profile-tools) use the same values; a test
// checks the copies in profile-tools/inbox-lib.ts stay equal to these.

export const SUPERVISOR_ADDRESS = /^supervisor:[a-z0-9-]{1,40}$/
export const SESSION_ADDRESS = /^session:ses_[A-Za-z0-9]{8,64}$/
export const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,64}$/
export const CURSOR = /^\d{1,15}$/

/** Text limit in UTF-8 bytes. */
export const MAX_TEXT_BYTES = 8 * 1024
/** Request body limit (text plus the JSON around it). */
export const MAX_BODY_BYTES = 16 * 1024
/** A message may be relayed at most this many times in one thread (correlationId). */
export const HOP_LIMIT = 3
/** Messages per minute per claimed sender. */
export const PER_SENDER_PER_MINUTE = 10
/**
 * Messages per minute over the whole box route. Box senders are only claimed, so a spoofer could
 * rotate made-up session ids to dodge the per-sender limit; this cap bounds that.
 */
export const BOX_ROUTE_PER_MINUTE = 60
export const DEFAULT_READ_LIMIT = 50
export const MAX_READ_LIMIT = 200
/** Admin tokens shorter than this are refused at start (the bridge sends 32 base64url chars). */
export const MIN_ADMIN_TOKEN_LENGTH = 32

export function isAddress(value: unknown): value is string {
  return typeof value === "string" && (SUPERVISOR_ADDRESS.test(value) || SESSION_ADDRESS.test(value))
}

export function textBytes(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

/**
 * One stored message. Mirrors InboxMessage in src/shared/contracts.ts (a test checks the two
 * stay assignable). `verified` is true only for `supervisor:` senders that used the admin token.
 */
export type StoredMessage = {
  id: string
  at: string
  from: string
  to: string
  text: string
  hops: number
  verified: boolean
  correlationId?: string
}
