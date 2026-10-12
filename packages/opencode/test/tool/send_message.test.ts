import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Cause, Exit } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SendMessageTool } from "../../src/tool/send_message"
import type { TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    Session.node,
    SessionRunState.node,
    SessionStatus.node,
    SessionProjector.node,
    Truncate.node,
    Database.node,
  ]),
)

const it = testEffect(layer)

function mockAssistantResponse(text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID: SessionID.make("ses_mock"),
      role: "assistant",
      agent: "build",
      modelID: "mock-model" as any,
      providerID: "mock-provider" as any,
      parentID: MessageID.ascending(),
      mode: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
    },
    parts: [
      {
        id: PartID.ascending(),
        sessionID: SessionID.make("ses_mock"),
        messageID: MessageID.ascending(),
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.send_message", () => {
  it.instance("fails when sending to parent from a root session without parent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const toolInfo = yield* SendMessageTool
      const tool = yield* toolInfo.init()

      const rootSession = yield* sessions.create({ title: "Root Session" })

      const ctx = {
        sessionID: rootSession.id,
        messageID: MessageID.ascending(),
        callID: "call_1",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const result = yield* Effect.exit(
        tool.execute({ recipient: "parent", message: "Hello parent!" }, ctx),
      )

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const err = Cause.pretty(result.cause)
        expect(err).toContain("has no parent session")
      }
    }),
  )

  it.instance("delivers message to parent session when parent exists", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const toolInfo = yield* SendMessageTool
      const tool = yield* toolInfo.init()

      const parentSession = yield* sessions.create({ title: "Parent Session" })
      const childSession = yield* sessions.create({
        parentID: parentSession.id,
        title: "Child Subagent",
      })

      const prompts: unknown[] = []
      const fakeOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) =>
          Effect.succeed([{ id: PartID.ascending(), type: "text", text: template }]),
        prompt: (input) => {
          prompts.push(input)
          return Effect.succeed(mockAssistantResponse("Got your message!"))
        },
      }

      const ctx = {
        sessionID: childSession.id,
        messageID: MessageID.ascending(),
        callID: "call_2",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
        extra: { promptOps: fakeOps },
      }

      const res = yield* tool.execute(
        { recipient: "parent", message: "Task 50% complete", correlation_id: "corr-1" },
        ctx,
      )

      expect(res.title).toContain("parent")
      expect(res.output).toContain("status=\"delivered\"")
      expect(prompts.length).toBe(1)
      const first = prompts[0] as { sessionID: SessionID; parts: { text: string }[] }
      expect(first.sessionID).toBe(parentSession.id)
      expect(first.parts[0].text).toContain("Task 50% complete")
      expect(first.parts[0].text).toContain("corr-1")
    }),
  )

  it.instance("supports wait_reply mode for direct session communication", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const toolInfo = yield* SendMessageTool
      const tool = yield* toolInfo.init()

      const s1 = yield* sessions.create({ title: "Session 1" })
      const s2 = yield* sessions.create({ title: "Session 2" })

      const fakeOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) =>
          Effect.succeed([{ id: PartID.ascending(), type: "text", text: template }]),
        prompt: () => Effect.succeed(mockAssistantResponse("Roger that, proceeding.")),
      }

      const ctx = {
        sessionID: s1.id,
        messageID: MessageID.ascending(),
        callID: "call_3",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
        extra: { promptOps: fakeOps },
      }

      const res = yield* tool.execute(
        {
          recipient: `session:${s2.id}`,
          message: "Status update request",
          mode: "wait_reply",
        },
        ctx,
      )

      expect(res.output).toContain("<message_reply")
      expect(res.output).toContain("Roger that, proceeding.")
      expect(res.metadata.reply).toBe("Roger that, proceeding.")
    }),
  )

  it.instance("sends message to external webhook URL", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const toolInfo = yield* SendMessageTool
      const tool = yield* toolInfo.init()

      const s = yield* sessions.create({ title: "Webhook Sender Session" })

      let rawPayload: unknown = null
      const server = Bun.serve({
        port: 0,
        fetch: async (req) => {
          rawPayload = await req.json()
          return new Response(JSON.stringify({ status: "acknowledged", agent: "Antigravity" }), {
            headers: { "content-type": "application/json" },
          })
        },
      })

      const webhookUrl = `http://127.0.0.1:${server.port}/inbox`

      const ctx = {
        sessionID: s.id,
        messageID: MessageID.ascending(),
        callID: "call_4",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      try {
        const res = yield* tool.execute(
          {
            recipient: webhookUrl,
            message: "Hello from OpenCode!",
            mode: "wait_reply",
            correlation_id: "thread-xyz",
          },
          ctx,
        )

        const payload = rawPayload as Record<string, unknown> | null
        expect(payload).not.toBeNull()
        expect(payload?.message).toBe("Hello from OpenCode!")
        expect(payload?.correlation_id).toBe("thread-xyz")
        expect(payload?.from).toBe(`session:${s.id}`)

        expect(res.output).toContain("Antigravity")
        expect(res.metadata.status).toBe("replied")
      } finally {
        void server.stop(true)
      }
    }),
  )

  it.instance("handles supervisor recipient when inbox is configured", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const toolInfo = yield* SendMessageTool
      const tool = yield* toolInfo.init()

      const s = yield* sessions.create({ title: "Supervisor Sender" })

      let rawInboxPayload: unknown = null
      const server = Bun.serve({
        port: 0,
        fetch: async (req) => {
          if (req.url.endsWith("/v1/post")) {
            rawInboxPayload = await req.json()
            return new Response(
              JSON.stringify({ message: { id: "msg_1", hops: 0, verified: false } }),
              { status: 201, headers: { "content-type": "application/json" } },
            )
          }
          return new Response("Not found", { status: 404 })
        },
      })

      const originalInbox = process.env.OCD_INBOX_URL
      process.env.OCD_INBOX_URL = `http://127.0.0.1:${server.port}`

      const ctx = {
        sessionID: s.id,
        messageID: MessageID.ascending(),
        callID: "call_5",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      try {
        const res = yield* tool.execute(
          {
            recipient: "supervisor",
            message: "Blocker encountered in test step 3",
            correlation_id: "blocker-1",
          },
          ctx,
        )

        const payload = rawInboxPayload as Record<string, unknown> | null
        expect(payload).not.toBeNull()
        expect(payload?.text).toBe("Blocker encountered in test step 3")
        expect(payload?.to).toBe("supervisor")
        expect(payload?.correlationId).toBe("blocker-1")

        expect(res.output).toContain("mode=\"inbox_posted\"")
      } finally {
        if (originalInbox !== undefined) {
          process.env.OCD_INBOX_URL = originalInbox
        } else {
          delete process.env.OCD_INBOX_URL
        }
        void server.stop(true)
      }
    }),
  )
})
