import { Effect } from "effect"
import { isRecord } from "@opencode/util/record"
import { Session } from "../session.js"

export const RETRY_MAX_RETRIES = 5
export type Err = {
  name?: string
  type?: string
  message?: string
  status?: number
  data?: {
    message?: string
    isRetryable?: boolean
    statusCode?: number
    responseHeaders?: Record<string, string>
    responseBody?: string
    metadata?: Record<string, unknown>
    [key: string]: unknown
  }
  [key: string]: unknown
}

const LONG_LADDER_PATTERNS = [
  /synapse_onprem_transport_timeout/i,
  /no further bytes arrived for \d+ ms/i,
  /fetch failed|failed to fetch/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT)\b/i,
  /timeout|timed out|socket/i,
]

const RATE_OR_OVERLOAD = /overloaded|rate[-_ ]?limit|too many requests/i

export function usesLongLadder(error: Err): boolean {
  if (error?.name === "ContextOverflowError") return false
  if (
    error?.type === "provider.auth" ||
    error?.type === "provider.rate-limit" ||
    error?.type === "provider.invalid-request" ||
    error?.type === "provider.quota" ||
    error?.type === "provider.free-limit"
  )
    return false
  const status = error?.data?.statusCode ?? error?.status
  if (status === 400 || status === 401 || status === 403 || status === 413 || status === 429) return false
  const msg = messageText(error)
  if (RATE_OR_OVERLOAD.test(msg)) return false
  if (status === 502 || status === 503 || status === 504) return true
  return LONG_LADDER_PATTERNS.some((pattern) => pattern.test(msg))
}

export const MESSAGE =
  "SYNAPSE_OUTAGE Synapse is offline (transport timeout). This session waited 5s, 15s, 45s, 2m, and 5m. Do not immediately resend the same large task."

export function haltError<T extends Err>(error: T, waits: number) {
  if (waits !== RETRY_MAX_RETRIES || !usesLongLadder(error)) return error
  return withOutageDetail(error)
}

export function withOutageDetail(error: Err) {
  const detail = messageText(error)
  if (!isRecord(error.data) && typeof error.message === "string") {
    return {
      ...error,
      message: MESSAGE,
    }
  }
  return {
    name: "APIError" as const,
    data: {
      message: MESSAGE,
      isRetryable: error.data?.isRetryable ?? true,
      ...(error.data?.statusCode === undefined ? {} : { statusCode: error.data.statusCode }),
      ...(error.data?.responseHeaders ? { responseHeaders: error.data.responseHeaders } : {}),
      ...(error.data?.responseBody === undefined ? {} : { responseBody: error.data.responseBody }),
      metadata: {
        ...(error.data?.metadata ?? {}),
        detail,
      },
    },
  }
}

export const note = Effect.fn("ParentAlert.note")(function* (input: {
  parentID: Session.ID
  agent: string
  providerID: string
  modelID: string
  variant?: string
}) {
  const sessions = yield* Session.Service
  const parent = yield* sessions.get(input.parentID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  if (!parent) return
  yield* sessions
    .synthetic({
      sessionID: parent.id,
      text: MESSAGE,
    })
    .pipe(Effect.ignore)
})

function messageText(error: Err) {
  if (isRecord(error.data) && typeof error.data.message === "string") return error.data.message
  if (typeof error.message === "string") return error.message
  return ""
}

export * as ParentAlert from "./parent-alert.js"
