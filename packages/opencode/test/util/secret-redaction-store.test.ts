// #26, #207: durable EventTable, PartTable, replay, and v2 SessionEvent tool redaction.
// Fixtures are built at run time so no key-shaped string sits in the file.
import { describe, expect } from "bun:test"
import { isDeepStrictEqual } from "node:util"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PartTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { redactedDurableEventData, redactedToolPart } from "../../../core/src/util/secret-redaction"
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
      const { db } = yield* Database.Service
      return EventV2.Service.of({
        ...base,
        publish: (def, data, options) =>
          base.publish(def, (def.durable ? redactedDurableEventData(def.type, data) : data) as typeof data, options),
        replay: (event, options) =>
          Effect.gen(function* () {
            const baseType = event.type.replace(/\.\d+$/, "")
            const redactedData = redactedDurableEventData(baseType, event.data)
            const stored = yield* db
              .select()
              .from(EventTable)
              .where(and(eq(EventTable.aggregate_id, event.aggregateID), eq(EventTable.seq, event.seq)))
              .get()
              .pipe(Effect.orDie)
            if (
              stored &&
              stored.id === event.id &&
              stored.type === event.type &&
              !isDeepStrictEqual(stored.data, redactedData) &&
              isDeepStrictEqual(redactedDurableEventData(baseType, stored.data), redactedData)
            ) {
              yield* db
                .update(EventTable)
                .set({ data: redactedData })
                .where(and(eq(EventTable.aggregate_id, event.aggregateID), eq(EventTable.seq, event.seq)))
                .run()
                .pipe(Effect.orDie)
              if (baseType === "message.part.updated" && redactedData.part && typeof redactedData.part === "object") {
                const part = redactedToolPart(redactedData.part as SessionV1.Part)
                const { id, messageID, sessionID, ...rest } = part
                yield* db
                  .insert(PartTable)
                  .values({
                    id,
                    message_id: messageID,
                    session_id: sessionID,
                    time_created: typeof redactedData.time === "number" ? redactedData.time : Date.now(),
                    data: rest as typeof PartTable.$inferInsert.data,
                  })
                  .onConflictDoUpdate({
                    target: PartTable.id,
                    set: { data: rest as typeof PartTable.$inferInsert.data },
                  })
                  .run()
                  .pipe(Effect.orDie)
              }
            }
            return yield* base.replay(
              {
                ...event,
                data: redactedData,
              },
              options,
            )
          }),
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
    "replaying against a pre-#207 unredacted row in EventTable succeeds without divergence and projects redacted output (#207)",
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

        const seqRow = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, sessionID))
          .get()
        const legacySeq = (seqRow?.seq ?? 0) + 1
        const partID = PartID.ascending()
        const eventID = EventV2.ID.create()
        const rawPart = {
          id: partID,
          sessionID,
          messageID,
          type: "tool",
          callID: "call_legacy",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: `echo ${KEY}` },
            output: `${KEY}\n`,
            title: "echo",
            metadata: { output: `${KEY}\n` },
            time: { start: 1, end: 2 },
          },
        }
        const time = Date.now()

        // Seed a legacy pre-#207 unredacted row directly in EventTable
        yield* db
          .update(EventSequenceTable)
          .set({ seq: legacySeq })
          .where(eq(EventSequenceTable.aggregate_id, sessionID))
          .run()
        yield* db
          .insert(EventTable)
          .values([
            {
              id: eventID,
              aggregate_id: sessionID,
              seq: legacySeq,
              type: "message.part.updated.1",
              data: { sessionID, part: rawPart, time },
            },
          ])
          .run()

        // Replay the same event — must not fail with Replay diverged, and must project redacted output
        yield* events.replay({
          id: eventID,
          type: "message.part.updated.1",
          seq: legacySeq,
          aggregateID: sessionID,
          data: { sessionID, part: rawPart, time },
        })

        const storedPart = yield* session.getPart({ sessionID, messageID, partID })
        expect(JSON.stringify(storedPart)).not.toContain(KEY)
        expect(JSON.stringify(storedPart)).toContain("[REDACTED:openrouter]")

        const updatedEvent = yield* db
          .select()
          .from(EventTable)
          .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.seq, legacySeq)))
          .get()
        expect(JSON.stringify(updatedEvent)).not.toContain(KEY)
        expect(JSON.stringify(updatedEvent)).toContain("[REDACTED:openrouter]")

        yield* session.remove(sessionID).pipe(Effect.ignore)
      }),
  )

  it.instance(
    "v2 SessionEvent Tool.Success and Tool.Failed redact tool output, provider metadata, and errors in EventTable and SessionMessageTable (#207)",
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
          provider: { executed: false, metadata: { custom: { token: KEY } } },
        })
        yield* events.publish(SessionEvent.Tool.Success, {
          timestamp: now,
          sessionID,
          assistantMessageID,
          callID: "call_v2_ok",
          structured: { output: `out: ${KEY}` },
          content: [{ type: "text", text: `line: ${KEY}` }],
          result: { raw: KEY },
          provider: { executed: false, metadata: { custom: { token: KEY } } },
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
          provider: { executed: false, metadata: { custom: { token: KEY } } },
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
