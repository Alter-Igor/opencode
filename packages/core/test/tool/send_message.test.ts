import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { SessionSchema } from "../../src/session/schema"
import { executeSendMessage, type SendMessagePromptOps } from "../../src/tool/send_message"

describe("tool.send_message", () => {
  test("fails when sending to parent from a root session without parent", async () => {
    const rootID = SessionSchema.ID.make("ses_root_1")
    const result = await Effect.runPromiseExit(
      executeSendMessage(
        { recipient: "parent", message: "Hello parent!" },
        rootID,
        AbortSignal.any([]),
        {
          getSession: (id) => Effect.succeed({ id, agent: "build" }),
        },
      ),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const err = Cause.pretty(result.cause)
      expect(err).toContain("has no parent session")
    }
  })

  test("delivers message to parent session when parent exists", async () => {
    const parentID = SessionSchema.ID.make("ses_parent_1")
    const childID = SessionSchema.ID.make("ses_child_1")
    const prompts: unknown[] = []
    const fakeOps: SendMessagePromptOps = {
      resolvePromptParts: (template) => Effect.succeed([{ type: "text", text: template }]),
      prompt: (input) => {
        prompts.push(input)
        return Effect.succeed({ parts: [{ type: "text", text: "Got your message!" }] })
      },
    }

    const res = await Effect.runPromise(
      executeSendMessage(
        { recipient: "parent", message: "Task 50% complete", correlation_id: "corr-1" },
        childID,
        AbortSignal.any([]),
        {
          getSession: (id) =>
            Effect.succeed(
              id === childID
                ? { id: childID, parentID, agent: "build" }
                : { id: parentID, agent: "build" },
            ),
          promptOps: fakeOps,
        },
      ),
    )

    expect(res.title).toContain("parent")
    expect(res.output).toContain('status="delivered"')
    expect(prompts.length).toBe(1)
    const first = prompts[0] as { sessionID: SessionSchema.ID; parts: { text: string }[] }
    expect(first.sessionID).toBe(parentID)
    expect(first.parts[0].text).toContain("Task 50% complete")
    expect(first.parts[0].text).toContain("corr-1")
  })

  test("supports wait_reply mode for direct session communication", async () => {
    const s1 = SessionSchema.ID.make("ses_one_1")
    const s2 = SessionSchema.ID.make("ses_two_2")
    const fakeOps: SendMessagePromptOps = {
      resolvePromptParts: (template) => Effect.succeed([{ type: "text", text: template }]),
      prompt: () => Effect.succeed({ parts: [{ type: "text", text: "Roger that, proceeding." }] }),
    }

    const res = await Effect.runPromise(
      executeSendMessage(
        {
          recipient: `session:${s2}`,
          message: "Status update request",
          mode: "wait_reply",
        },
        s1,
        AbortSignal.any([]),
        {
          getSession: (id) => Effect.succeed({ id, agent: "build" }),
          promptOps: fakeOps,
        },
      ),
    )

    expect(res.output).toContain("<message_reply")
    expect(res.output).toContain("Roger that, proceeding.")
    expect(res.metadata.reply).toBe("Roger that, proceeding.")
  })

  test("sends message to external webhook URL", async () => {
    const s = SessionSchema.ID.make("ses_webhook_1")
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

    try {
      const res = await Effect.runPromise(
        executeSendMessage(
          {
            recipient: webhookUrl,
            message: "Hello from OpenCode!",
            mode: "wait_reply",
            correlation_id: "thread-xyz",
          },
          s,
          AbortSignal.any([]),
          {
            getSession: (id) => Effect.succeed({ id, agent: "build" }),
          },
        ),
      )

      const payload = rawPayload as Record<string, unknown> | null
      expect(payload).not.toBeNull()
      expect(payload?.message).toBe("Hello from OpenCode!")
      expect(payload?.correlation_id).toBe("thread-xyz")
      expect(payload?.from).toBe(`session:${s}`)

      expect(res.output).toContain("Antigravity")
      expect(res.metadata.status).toBe("replied")
    } finally {
      void server.stop(true)
    }
  })

  test("handles supervisor recipient when inbox is configured", async () => {
    const s = SessionSchema.ID.make("ses_supervisor_1")
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

    try {
      const res = await Effect.runPromise(
        executeSendMessage(
          {
            recipient: "supervisor",
            message: "Blocker encountered in test step 3",
            correlation_id: "blocker-1",
          },
          s,
          AbortSignal.any([]),
          {
            getSession: (id) => Effect.succeed({ id, agent: "build" }),
          },
        ),
      )

      const payload = rawInboxPayload as Record<string, unknown> | null
      expect(payload).not.toBeNull()
      expect(payload?.text).toBe("Blocker encountered in test step 3")
      expect(payload?.to).toBe("supervisor")
      expect(payload?.correlationId).toBe("blocker-1")

      expect(res.output).toContain('mode="inbox_posted"')
    } finally {
      if (originalInbox !== undefined) {
        process.env.OCD_INBOX_URL = originalInbox
      } else {
        delete process.env.OCD_INBOX_URL
      }
      void server.stop(true)
    }
  })
})
