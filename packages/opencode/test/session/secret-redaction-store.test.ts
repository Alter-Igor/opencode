// #26 (QA): Session.updatePart stores a redacted copy of a tool part and hands the caller's
// part back unchanged. Fixtures are built at run time so no key-shaped string sits in the file.
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node])))

const KEY = "sk-" + "or-v1-" + "5a5f0c".repeat(11)

describe("Session.updatePart redaction (#26)", () => {
  it.instance("stores a redacted copy of a tool part and returns the caller's part unchanged", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
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
      const text = JSON.stringify(stored)
      expect(text).not.toContain(KEY)
      expect(text).toContain("[REDACTED:openrouter]")
      yield* session.remove(sessionID).pipe(Effect.ignore)
    }),
  )
})
