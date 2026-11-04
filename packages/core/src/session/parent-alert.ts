import { Effect } from "effect"
import { isRecord } from "@opencode/util/record"
import { Session } from "../session.js"

export const RETRY_MAX_RETRIES = 5
export type Err = {
  name?: string
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

export function usesLongLadder(error: Err): boolean {
  const msg = messageText(error).toLowerCase()
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("fetch failed") ||
    msg.includes("socket") ||
    error?.data?.statusCode === 502 ||
    error?.data?.statusCode === 503 ||
    error?.data?.statusCode === 504
  )
}

export const MESSAGE =
  "SYNAPSE_OUTAGE Synapse is offline (transport timeout). This session waited 5s, 15s, 45s, 2m, and 5m. Do not immediately resend the same large task."

export function haltError<T extends Err>(error: T, waits: number) {
  if (waits !== RETRY_MAX_RETRIES || !usesLongLadder(error)) return error
  return withOutageDetail(error)
}

export function withOutageDetail(error: Err) {
  const detail = messageText(error)
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
  if (!isRecord(error.data)) return ""
  return typeof error.data.message === "string" ? error.data.message : ""
}

export * as ParentAlert from "./parent-alert.js"
