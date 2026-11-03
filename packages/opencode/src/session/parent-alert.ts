// Do not import prompt.ts. The processor calls this during halt, and SessionPrompt imports the processor.
import { Effect, Option } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { isRecord } from "@/util/record"
import { MessageID, PartID, type SessionID } from "./schema"
import { Session } from "./session"
import { RETRY_MAX_RETRIES, usesLongLadder, type Err } from "./retry"

export const MESSAGE =
  "SYNAPSE_OUTAGE Synapse is offline (transport timeout). This session waited 5s, 15s, 45s, 2m, and 5m. Do not immediately resend the same large task."

// The sentence names every wait, so it is only for the give-up after all five.
export function haltError(error: Err, waits: number) {
  if (waits !== RETRY_MAX_RETRIES || !usesLongLadder(error)) return error
  return withOutageDetail(error)
}

export function withOutageDetail(error: Err) {
  const detail = messageText(error)
  if (!SessionV1.APIError.isInstance(error)) {
    return new SessionV1.APIError({
      message: MESSAGE,
      isRetryable: true,
      metadata: { detail },
    }).toObject()
  }
  return new SessionV1.APIError({
    message: MESSAGE,
    isRetryable: error.data.isRetryable,
    ...(error.data.statusCode === undefined ? {} : { statusCode: error.data.statusCode }),
    ...(error.data.responseHeaders ? { responseHeaders: error.data.responseHeaders } : {}),
    ...(error.data.responseBody === undefined ? {} : { responseBody: error.data.responseBody }),
    metadata: {
      ...(error.data.metadata ?? {}),
      detail,
    },
  }).toObject()
}

export const note = Effect.fn("ParentAlert.note")(function* (input: {
  parentID: SessionID
  agent: string
  providerID: SessionV1.User["model"]["providerID"]
  modelID: SessionV1.User["model"]["modelID"]
  variant?: string
}) {
  const sessions = yield* Session.Service
  const parent = yield* sessions.get(input.parentID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  if (!parent) return
  const found = yield* sessions
    .findMessage(parent.id, (msg) => msg.info.role === "assistant")
    .pipe(Effect.catchCause(() => Effect.succeed(Option.none())))
  if (Option.isSome(found)) {
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: found.value.info.id,
      sessionID: parent.id,
      type: "text",
      text: MESSAGE,
    } satisfies SessionV1.TextPart)
    return
  }
  const message: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID: parent.id,
    role: "user",
    time: { created: Date.now() },
    agent: parent.agent ?? input.agent,
    model: {
      providerID: input.providerID,
      modelID: input.modelID,
      ...(input.variant ? { variant: input.variant } : {}),
    },
  }
  yield* sessions.updateMessage(message)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: message.id,
    sessionID: parent.id,
    type: "text",
    synthetic: true,
    text: MESSAGE,
  } satisfies SessionV1.TextPart)
})

function messageText(error: Err) {
  if (!isRecord(error.data)) return ""
  return typeof error.data.message === "string" ? error.data.message : ""
}

export * as ParentAlert from "./parent-alert"
