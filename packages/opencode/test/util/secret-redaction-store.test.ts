// #26, #207: durable EventTable, PartTable, replay, and v2 SessionEvent tool redaction.
// Fixtures are built at run time so no key-shaped string sits in the file.
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { redactedDurableEventData } from "../../../core/src/util/secret-redaction"
import { Session } from "@/session/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const redactedEventV2Node = LayerNode.make({
  service: EventV2.Service,
  tag: EventV2.node.tag,
  deps: [Database.node],
  layer: Layer.effect(
    EventV2.Service,
    Effect.gen(function* () {
      const base = yield* EventV2.Service
      return EventV2.Service.of({
        ...base,
        publish: (def, data, options) =>
          base.publish(def, (def.durable ? redactedDurableEventData(def.type, data) : data) as typeof data, options),
        replay: (event, options) => {
          const baseType = event.type.replace(/\.\d+$/, "")
          return base.replay(
            {
              ...event,
              data: redactedDurableEventData(baseType, event.data),
            },
            options,
          )
        },
      })
    }),
  ).pipe(Layer.provide(EventV2.layerWith())),
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, MessageV2.node, SessionProjector.node, EventV2Bridge.node, Database.node]),
    [[EventV2.node, redactedEventV2Node]],
  ),
)

const KEY = "sk-" + "or-v1-" + "5a5f0c".repeat(11)

describe("Durable event and store secret redaction (#26, #207)", () => {
  it.instance("Session.updatePart stores redacted part in both PartTable and EventTable", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({})
      const sessionID = created.id
      const messageID = MessageID.ascending()
      yield* session.updateMessage({
        id: messageID,
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as SessionV1.Info)
      const partID = PartID.ascending()
      const part = {
        id: partID,
        sessionID,
        messageID,
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: `echo ${KEY}` },
          output: `${KEY}\n`,
          title: "echo",
          metadata: { output: `${KEY}\n` },
          time: { start: 1, end: 2 },
        },
      } as unknown as SessionV1.Part

      const returned = yield* session.updatePart(part)
      expect(JSON.stringify(returned)).toContain(KEY)

      const stored = yield* session.getPart({ sessionID, messageID, partID })
      expect(JSON.stringify(stored)).not.toContain(KEY)
      expect(JSON.stringify(stored)).toContain("[REDACTED:openrouter]")

      const eventRows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()
      expect(JSON.stringify(eventRows)).not.toContain(KEY)
      expect(JSON.stringify(eventRows)).toContain("[REDACTED:openrouter]")
      yield* session.remove(sessionID).pipe(Effect.ignore)
    }),
  )

  it.instance(
    "commitDurableEvent redacts EventTable and PartTable on direct publish and replay while keeping replay idempotent (#207)",
    () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const events = yield* EventV2Bridge.Service
        const { db } = yield* Database.Service
        const created = yield* session.create({})
        const sessionID = created.id
        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)
        const partID = PartID.ascending()
        const part = {
          id: partID,
          sessionID,
          messageID,
          type: "tool",
          callID: "call_2",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: `echo ${KEY}` },
            output: `${KEY}\n`,
            title: "echo",
            metadata: { output: `${KEY}\n` },
            time: { start: 1, end: 2 },
          },
        } as unknown as SessionV1.Part

        const published = yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID,
          part,
          time: Date.now(),
        })
        expect(JSON.stringify(part)).toContain(KEY)
        expect(JSON.stringify(published.data)).not.toContain(KEY)
        expect(JSON.stringify(published.data)).toContain("[REDACTED:openrouter]")

        const eventRows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()
        expect(JSON.stringify(eventRows)).not.toContain(KEY)
        expect(JSON.stringify(eventRows)).toContain("[REDACTED:openrouter]")

        // Replaying the same event (even with unredacted input payload from an older instance) is idempotent
        yield* events.replay({
          id: published.id,
          type: "message.part.updated.1",
          seq: published.durable!.seq,
          aggregateID: sessionID,
          data: {
            sessionID,
            part,
            time: (published.data as { time: number }).time,
          },
        })

        const stored = yield* session.getPart({ sessionID, messageID, partID })
        expect(JSON.stringify(stored)).not.toContain(KEY)
        expect(JSON.stringify(stored)).toContain("[REDACTED:openrouter]")
        yield* session.remove(sessionID).pipe(Effect.ignore)
      }),
  )

  it.instance(
    "v2 SessionEvent Tool.Success and Tool.Failed redact tool output and errors in EventTable and SessionMessageTable (#207)",
    () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const events = yield* EventV2Bridge.Service
        const { db } = yield* Database.Service
        const created = yield* session.create({})
        const sessionID = created.id
        const assistantMessageID = SessionMessage.ID.create()
        const now = DateTime.makeUnsafe(1000)
        const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

        yield* events.publish(SessionEvent.Step.Started, {
          timestamp: now,
          sessionID,
          assistantMessageID,
          agent: "build",
          model,
        })
        yield* events.publish(SessionEvent.Tool.Input.Started, {
          timestamp: now,
          sessionID,
          assistantMessageID,
          callID: "call_v2_ok",
          name: "bash",
        })
        yield* events.publish(SessionEvent.Tool.Called, {
          timestamp: now,
          sessionID,
          assistantMessageID,
          callID: "call_v2_ok",
          tool: "bash",
          input: { command: `echo ${KEY}` },
          provider: { executed: false },
        })
        yield* events.publish(SessionEvent.Tool.Success, {
          timestamp: now,
          sessionID,
          assistantMessageID,
          callID: "call_v2_ok",
          structured: { output: `out: ${KEY}` },
          content: [{ type: "text", text: `line: ${KEY}` }],
          result: { raw: KEY },
          provider: { executed: false },
        })
        yield* events.publish(SessionEvent.Tool.Input.Started, {
          timestamp: now,
          sessionID,
          assistantMessageID,
          callID: "call_v2_err",
          name: "bash",
        })
        yield* events.publish(SessionEvent.Tool.Failed, {
          timestamp: now,
          sessionID,
          assistantMessageID,
          callID: "call_v2_err",
          error: { type: "unknown", message: `failed with ${KEY}` },
          result: { err: KEY },
          provider: { executed: false },
        })

        const messageRows = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .all()
        const messageText = JSON.stringify(messageRows)
        expect(messageText).not.toContain(KEY)
        expect(messageText).toContain("[REDACTED:openrouter]")

        const eventRows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()
        const eventText = JSON.stringify(eventRows)
        expect(eventText).not.toContain(KEY)
        expect(eventText).toContain("[REDACTED:openrouter]")

        yield* session.remove(sessionID).pipe(Effect.ignore)
      }),
  )
})
