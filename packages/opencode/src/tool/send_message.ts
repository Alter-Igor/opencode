import { Effect, Schema, Scope } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./send_message.txt"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { Agent } from "../agent/agent"
import type { TaskPromptOps } from "./task"
import { Config } from "@/config/config"

const id = "send_message"

export const Parameters = Schema.Struct({
  recipient: Schema.String.annotate({
    description:
      "Recipient address: 'parent' (parent session), 'session:<id>' (session ID), 'agent:<name>' (subagent type), 'supervisor' (external supervisor/inbox), or an HTTP webhook URL ('https://...')",
  }),
  message: Schema.String.annotate({
    description: "The message text to send",
  }),
  mode: Schema.optional(Schema.Literals(["fire_and_forget", "wait_reply"])).annotate({
    description:
      "Delivery mode: 'fire_and_forget' (default, posts message and returns immediately) or 'wait_reply' (waits for recipient to respond)",
  }),
  correlation_id: Schema.optional(Schema.String).annotate({
    description: "Optional conversation or correlation tracking ID",
  }),
})

export type Metadata = {
  target?: string
  targetSessionID?: string
  reply?: string
  status?: string
}

export const SendMessageTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agentService = yield* Agent.Service
    const config = yield* Config.Service
    const scope = yield* Scope.Scope

    const run = Effect.fn("SendMessageTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const mode = params.mode ?? "fire_and_forget"
      const recipient = params.recipient.trim()

      const response = (
        output: string,
        meta: Metadata = {},
        title = `Sent message to ${recipient}`,
      ): Tool.ExecuteResult<Metadata> => ({
        title,
        output,
        metadata: meta,
      })

      // 1. External Webhook (http:// or https://)
      if (recipient.startsWith("http://") || recipient.startsWith("https://")) {
        yield* ctx.ask({
          permission: "webfetch",
          patterns: [recipient],
          always: ["*"],
          metadata: {
            url: recipient,
          },
        })

        const payload = {
          from: `session:${ctx.sessionID}`,
          recipient,
          message: params.message,
          correlation_id: params.correlation_id,
          timestamp: new Date().toISOString(),
        }

        const timeoutSignal = AbortSignal.any([ctx.abort, AbortSignal.timeout(30_000)])

        if (mode === "wait_reply") {
          const res = yield* Effect.tryPromise({
            try: async () => {
              const r = await fetch(recipient, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
                signal: timeoutSignal,
              })
              const text = await r.text().catch(() => "")
              return { ok: r.ok, status: r.status, text }
            },
            catch: (err) => new Error(`Failed to send message to webhook ${recipient}: ${String(err)}`),
          })

          if (!res.ok) {
            return yield* Effect.fail(new Error(`Webhook ${recipient} returned HTTP ${res.status}: ${res.text}`))
          }

          return response(
            `<message_reply from="${recipient}">\n${res.text}\n</message_reply>`,
            { target: recipient, reply: res.text, status: "replied" },
            `Received reply from ${recipient}`,
          )
        }

        // fire_and_forget
        yield* Effect.promise(async () => {
          try {
            await fetch(recipient, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
              signal: timeoutSignal,
            })
          } catch {
            // Background fire-and-forget ignores network delivery errors
          }
        }).pipe(Effect.forkIn(scope, { startImmediately: true }))

        return response(
          `<message_delivery status="dispatched" recipient="${recipient}" mode="fire_and_forget" />`,
          { target: recipient, status: "dispatched" },
        )
      }

      // 2. External Supervisor or Named External Harness
      if (
        recipient === "supervisor" ||
        recipient.startsWith("supervisor:") ||
        recipient.startsWith("external:")
      ) {
        const inboxUrl = process.env.OCD_INBOX_URL || process.env.OPENCODE_DELEGATE_INBOX_URL
        const webhookUrl =
          process.env.SUPERVISOR_WEBHOOK_URL ||
          (recipient === "external:claude" ? process.env.CLAUDE_WEBHOOK_URL : undefined) ||
          (recipient === "external:gy" || recipient === "external:antigravity"
            ? process.env.ANTIGRAVITY_WEBHOOK_URL
            : undefined)

        const supervisorTimeoutSignal = AbortSignal.any([ctx.abort, AbortSignal.timeout(15_000)])

        if (inboxUrl) {
          const postUrl = `${inboxUrl}/v1/post`
          const toAddress = recipient.startsWith("supervisor:") ? recipient : "supervisor"
          const res = yield* Effect.tryPromise({
            try: async () => {
              const r = await fetch(postUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  from: `session:${ctx.sessionID}`,
                  to: toAddress,
                  text: params.message,
                  correlationId: params.correlation_id,
                }),
                signal: supervisorTimeoutSignal,
              })
              const data = await r.json().catch(() => ({}))
              return { ok: r.ok, status: r.status, data }
            },
            catch: (err) => new Error(`Could not reach delegate inbox at ${postUrl}: ${String(err)}`),
          })

          if (!res.ok) {
            return yield* Effect.fail(
              new Error(`Delegate inbox refused message (HTTP ${res.status}): ${JSON.stringify(res.data)}`),
            )
          }

          return response(
            `<message_delivery status="delivered" recipient="${recipient}" mode="inbox_posted" />`,
            { target: recipient, status: "posted" },
          )
        }

        if (webhookUrl) {
          const res = yield* Effect.tryPromise({
            try: async () => {
              const r = await fetch(webhookUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  from: `session:${ctx.sessionID}`,
                  recipient,
                  message: params.message,
                  correlation_id: params.correlation_id,
                }),
                signal: supervisorTimeoutSignal,
              })
              const text = await r.text().catch(() => "")
              return { ok: r.ok, status: r.status, text }
            },
            catch: (err) => new Error(`Could not reach supervisor webhook: ${String(err)}`),
          })

          if (!res.ok) {
            return yield* Effect.fail(
              new Error(`Supervisor webhook returned HTTP ${res.status}: ${res.text}`),
            )
          }

          return response(
            `<message_delivery status="delivered" recipient="${recipient}" mode="webhook_posted" />`,
            { target: recipient, status: "dispatched" },
          )
        }

        // Neither is set: return clean guidance
        return response(
          `<message_delivery status="queued_local" recipient="${recipient}">No external supervisor bridge configured (OCD_INBOX_URL or SUPERVISOR_WEBHOOK_URL not set). Message recorded in session history.</message_delivery>`,
          { target: recipient, status: "queued_local" },
          `Queued message for ${recipient}`,
        )
      }

      // 3. Internal OpenCode Sessions (parent, session:<id>, agent:<name>)
      let targetSessionID: SessionID
      let targetAgentName: string | undefined

      if (recipient === "parent") {
        const current = yield* sessions.get(ctx.sessionID)
        if (!current.parentID) {
          return yield* Effect.fail(
            new Error(
              `Cannot send message to parent: session ${ctx.sessionID} has no parent session (it is a root session).`,
            ),
          )
        }
        targetSessionID = current.parentID
        const parentSession = yield* sessions.get(targetSessionID)
        targetAgentName = parentSession.agent
      } else if (recipient.startsWith("session:")) {
        const rawId = recipient.slice("session:".length)
        targetSessionID = SessionID.make(rawId)
        const targetSession = yield* sessions.get(targetSessionID)
        targetAgentName = targetSession.agent
      } else if (recipient.startsWith("agent:")) {
        const agentName = recipient.slice("agent:".length)
        const targetAgent = yield* agentService.get(agentName)
        if (!targetAgent) {
          return yield* Effect.fail(new Error(`Agent "${agentName}" does not exist.`))
        }

        // Check if an existing subagent child session exists under this parent
        const allSessions = yield* sessions.list()
        const existing = allSessions.find(
          (c) => c.parentID === ctx.sessionID && c.agent === targetAgent.name,
        )

        if (existing) {
          targetSessionID = existing.id
          targetAgentName = existing.agent
        } else {
          const child = yield* sessions.create({
            parentID: ctx.sessionID,
            title: `Subagent @${targetAgent.name}`,
            agent: targetAgent.name,
          })
          targetSessionID = child.id
          targetAgentName = targetAgent.name
        }
      } else if (recipient.startsWith("ses_")) {
        targetSessionID = SessionID.make(recipient)
        const targetSession = yield* sessions.get(targetSessionID)
        targetAgentName = targetSession.agent
      } else {
        return yield* Effect.fail(
          new Error(
            `Unsupported recipient format: "${recipient}". Supported formats: "parent", "session:<id>", "agent:<name>", "supervisor", or "https://...".`,
          ),
        )
      }

      const senderAddress = `session:${ctx.sessionID}`
      const formattedMessage = [
        `<incoming_message from="${senderAddress}"${params.correlation_id ? ` correlation_id="${params.correlation_id}"` : ""}>`,
        params.message,
        `</incoming_message>`,
      ].join("\n")

      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) {
        return response(
          `<message_delivery status="queued" recipient="${recipient}" target_session="${targetSessionID}" />`,
          { target: recipient, targetSessionID, status: "queued" },
          `Message routed to ${targetSessionID}`,
        )
      }

      const parts = yield* ops.resolvePromptParts(formattedMessage)

      if (mode === "wait_reply") {
        // If messaging parent while in foreground mode, avoid synchronous deadlock
        const current = yield* sessions.get(ctx.sessionID)
        if (recipient === "parent" && current.parentID === targetSessionID) {
          // Fire into parent session and return acknowledgment so child can complete turn and let parent reply
          yield* ops
            .prompt({
              messageID: MessageID.ascending(),
              sessionID: targetSessionID,
              agent: targetAgentName,
              parts,
            })
            .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))

          return response(
            `<message_delivery status="delivered" recipient="parent" target_session="${targetSessionID}" note="Delivered to parent inbox. Complete your turn to yield control to parent." />`,
            { target: recipient, targetSessionID, status: "delivered_to_parent" },
            `Sent message to parent ${targetSessionID}`,
          )
        }

        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: targetSessionID,
          agent: targetAgentName,
          parts,
        })

        const replyText = result.parts.findLast((p) => p.type === "text")?.text ?? ""
        return response(
          `<message_reply from="${recipient}" session="${targetSessionID}">\n${replyText}\n</message_reply>`,
          { target: recipient, targetSessionID, reply: replyText, status: "replied" },
          `Received reply from ${recipient}`,
        )
      }

      // fire_and_forget: fork asynchronously into target session
      yield* ops
        .prompt({
          messageID: MessageID.ascending(),
          sessionID: targetSessionID,
          agent: targetAgentName,
          parts,
        })
        .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))

      return response(
        `<message_delivery status="delivered" recipient="${recipient}" target_session="${targetSessionID}" mode="fire_and_forget" />`,
        { target: recipient, targetSessionID, status: "delivered" },
        `Sent message to ${recipient}`,
      )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
