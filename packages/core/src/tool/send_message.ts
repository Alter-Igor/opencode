export * as SendMessageTool from "./send_message.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Agent } from "../agent.js"
import { Permission } from "../permission.js"
import { Session } from "../session.js"
import { SessionSchema } from "../session/schema.js"
import DESCRIPTION from "./send_message.txt"

export const id = "send_message"
export const name = "send_message"

export const Parameters = Schema.Struct({
  recipient: Schema.String.annotate({
    description:
      "Recipient address: 'parent' (parent session), 'session:<id>' (session ID), 'agent:<name>' (subagent type), 'supervisor' (external supervisor/inbox), or an HTTP webhook URL ('https://...')",
  }),
  message: Schema.String.annotate({
    description: "The message text to send",
  }),
  mode: Schema.optionalKey(Schema.Literals(["fire_and_forget", "wait_reply"])).annotate({
    description:
      "Delivery mode: 'fire_and_forget' (default, posts message and returns immediately) or 'wait_reply' (waits for recipient to respond)",
  }),
  correlation_id: Schema.optionalKey(Schema.String).annotate({
    description: "Optional conversation or correlation tracking ID",
  }),
})

export const Input = Parameters

export const Output = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
  target: Schema.optionalKey(Schema.String),
  targetSessionID: Schema.optionalKey(Schema.String),
  reply: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
})

export type Metadata = {
  target?: string
  targetSessionID?: string
  reply?: string
  status?: string
}

export interface SendMessagePromptOps {
  resolvePromptParts?: (text: string) => Effect.Effect<Array<{ id?: string; type: string; text: string }>>
  prompt: (input: {
    messageID?: string
    sessionID: SessionSchema.ID
    agent?: string
    parts: Array<{ id?: string; type: string; text: string }>
  }) => Effect.Effect<{ parts: Array<{ type: string; text?: string }> }>
}

export interface SendMessageDeps {
  getSession: (id: SessionSchema.ID) => Effect.Effect<{ id: SessionSchema.ID; parentID?: SessionSchema.ID; agent?: string }, unknown>
  listSessions?: () => Effect.Effect<ReadonlyArray<{ id: SessionSchema.ID; parentID?: SessionSchema.ID; agent?: string }>, unknown>
  createSession?: (input: { parentID: SessionSchema.ID; title: string; agent: string }) => Effect.Effect<{ id: SessionSchema.ID; agent?: string }, unknown>
  resolveAgent?: (name: string) => Effect.Effect<{ name: string } | undefined, unknown>
  promptSession?: (input: { sessionID: SessionSchema.ID; text: string }) => Effect.Effect<unknown, unknown>
  askWebfetch?: (url: string) => Effect.Effect<void, unknown>
  promptOps?: SendMessagePromptOps
}

export const executeSendMessage = Effect.fn("SendMessageTool.execute")(function* (
  params: Schema.Schema.Type<typeof Parameters>,
  sessionID: SessionSchema.ID,
  abort: AbortSignal,
  deps: SendMessageDeps,
) {
  const mode = params.mode ?? "fire_and_forget"
  const recipient = params.recipient.trim()

  const response = (output: string, meta: Metadata = {}, title = `Sent message to ${recipient}`) => ({
    title,
    output,
    metadata: meta,
  })

  // 1. External Webhook (http:// or https://)
  if (recipient.startsWith("http://") || recipient.startsWith("https://")) {
    if (deps.askWebfetch) {
      yield* deps.askWebfetch(recipient).pipe(
        Effect.mapError((error) => new ToolFailure({ message: `Webfetch denied for ${recipient}`, error })),
      )
    }

    const payload = {
      from: `session:${sessionID}`,
      recipient,
      message: params.message,
      correlation_id: params.correlation_id,
      timestamp: new Date().toISOString(),
    }

    const timeoutSignal = AbortSignal.any([abort, AbortSignal.timeout(30_000)])

    if (mode === "wait_reply") {
      const res = yield* Effect.tryPromise({
        try: async (effectSignal) => {
          const r = await fetch(recipient, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.any([timeoutSignal, effectSignal]),
          })
          const text = await r.text().catch(() => "")
          return { ok: r.ok, status: r.status, text }
        },
        catch: (err) => new ToolFailure({ message: `Failed to send message to webhook ${recipient}: ${String(err)}` }),
      })

      if (!res.ok) {
        return yield* new ToolFailure({ message: `Webhook ${recipient} returned HTTP ${res.status}: ${res.text}` })
      }

      return response(
        `<message_reply from="${recipient}">\n${res.text}\n</message_reply>`,
        { target: recipient, reply: res.text, status: "replied" },
        `Received reply from ${recipient}`,
      )
    }

    void fetch(recipient, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: timeoutSignal,
    }).catch(() => {})

    return response(
      `<message_delivery status="dispatched" recipient="${recipient}" mode="fire_and_forget" />`,
      { target: recipient, status: "dispatched" },
    )
  }

  // 2. External Supervisor or Named External Harness
  if (recipient === "supervisor" || recipient.startsWith("supervisor:") || recipient.startsWith("external:")) {
    const inboxUrl = process.env.OCD_INBOX_URL || process.env.OPENCODE_DELEGATE_INBOX_URL
    const webhookUrl =
      process.env.SUPERVISOR_WEBHOOK_URL ||
      (recipient === "external:claude" ? process.env.CLAUDE_WEBHOOK_URL : undefined) ||
      (recipient === "external:gy" || recipient === "external:antigravity"
        ? process.env.ANTIGRAVITY_WEBHOOK_URL
        : undefined)

    const supervisorTimeoutSignal = AbortSignal.any([abort, AbortSignal.timeout(15_000)])

    if (inboxUrl) {
      const postUrl = `${inboxUrl}/v1/post`
      const toAddress = recipient.startsWith("supervisor:") ? recipient : "supervisor"
      const res = yield* Effect.tryPromise({
        try: async (effectSignal) => {
          const r = await fetch(postUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              from: `session:${sessionID}`,
              to: toAddress,
              text: params.message,
              correlationId: params.correlation_id,
            }),
            signal: AbortSignal.any([supervisorTimeoutSignal, effectSignal]),
          })
          const data = await r.json().catch(() => ({}))
          return { ok: r.ok, status: r.status, data }
        },
        catch: (err) => new ToolFailure({ message: `Could not reach delegate inbox at ${postUrl}: ${String(err)}` }),
      })

      if (!res.ok) {
        return yield* new ToolFailure({
          message: `Delegate inbox refused message (HTTP ${res.status}): ${JSON.stringify(res.data)}`,
        })
      }

      return response(
        `<message_delivery status="delivered" recipient="${recipient}" mode="inbox_posted" />`,
        { target: recipient, status: "posted" },
      )
    }

    if (webhookUrl) {
      const res = yield* Effect.tryPromise({
        try: async (effectSignal) => {
          const r = await fetch(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              from: `session:${sessionID}`,
              recipient,
              message: params.message,
              correlation_id: params.correlation_id,
            }),
            signal: AbortSignal.any([supervisorTimeoutSignal, effectSignal]),
          })
          const text = await r.text().catch(() => "")
          return { ok: r.ok, status: r.status, text }
        },
        catch: (err) => new ToolFailure({ message: `Could not reach supervisor webhook: ${String(err)}` }),
      })

      if (!res.ok) {
        return yield* new ToolFailure({ message: `Supervisor webhook returned HTTP ${res.status}: ${res.text}` })
      }

      return response(
        `<message_delivery status="delivered" recipient="${recipient}" mode="webhook_posted" />`,
        { target: recipient, status: "dispatched" },
      )
    }

    return response(
      `<message_delivery status="queued_local" recipient="${recipient}">No external supervisor bridge configured (OCD_INBOX_URL or SUPERVISOR_WEBHOOK_URL not set). Message recorded in session history.</message_delivery>`,
      { target: recipient, status: "queued_local" },
      `Queued message for ${recipient}`,
    )
  }

  // 3. Internal OpenCode Sessions (parent, session:<id>, agent:<name>)
  let targetSessionID: SessionSchema.ID
  let targetAgentName: string | undefined

  if (recipient === "parent") {
    const current = yield* deps.getSession(sessionID).pipe(
      Effect.mapError((error) => new ToolFailure({ message: `Session not found: ${sessionID}`, error })),
    )
    if (!current.parentID) {
      return yield* new ToolFailure({
        message: `Cannot send message to parent: session ${sessionID} has no parent session (it is a root session).`,
      })
    }
    targetSessionID = current.parentID
    const parentSession = yield* deps.getSession(targetSessionID).pipe(
      Effect.mapError((error) => new ToolFailure({ message: `Parent session not found: ${targetSessionID}`, error })),
    )
    targetAgentName = parentSession.agent
  } else if (recipient.startsWith("session:")) {
    const rawId = recipient.slice("session:".length)
    const decoded = Schema.decodeUnknownOption(SessionSchema.ID)(rawId)
    if (decoded._tag === "None") {
      return yield* new ToolFailure({ message: `Invalid session ID: ${rawId}` })
    }
    targetSessionID = decoded.value
    const targetSession = yield* deps.getSession(targetSessionID).pipe(
      Effect.mapError((error) => new ToolFailure({ message: `Session not found: ${targetSessionID}`, error })),
    )
    targetAgentName = targetSession.agent
  } else if (recipient.startsWith("agent:")) {
    const agentName = recipient.slice("agent:".length)
    const targetAgent = deps.resolveAgent
      ? yield* deps.resolveAgent(agentName).pipe(
          Effect.mapError((error) => new ToolFailure({ message: `Agent lookup failed: ${agentName}`, error })),
        )
      : undefined
    if (!targetAgent) {
      return yield* new ToolFailure({ message: `Agent "${agentName}" does not exist.` })
    }
    const resolvedAgentID = (targetAgent as { id?: string }).id ?? targetAgent.name

    const allSessions = deps.listSessions
      ? yield* deps.listSessions().pipe(Effect.orElseSucceed(() => []))
      : []
    const existing = allSessions.find(
      (c) => c.parentID === sessionID && (c.agent === resolvedAgentID || c.agent === targetAgent.name),
    )

    if (existing) {
      targetSessionID = existing.id
      targetAgentName = existing.agent
    } else if (deps.createSession) {
      const child = yield* deps
        .createSession({
          parentID: sessionID,
          title: `Subagent @${targetAgent.name}`,
          agent: resolvedAgentID,
        })
        .pipe(Effect.mapError((error) => new ToolFailure({ message: `Failed to create session`, error })))
      targetSessionID = child.id
      targetAgentName = child.agent
    } else {
      return yield* new ToolFailure({ message: `Cannot create session for agent "${agentName}".` })
    }
  } else if (recipient.startsWith("ses_")) {
    const decoded = Schema.decodeUnknownOption(SessionSchema.ID)(recipient)
    if (decoded._tag === "None") {
      return yield* new ToolFailure({ message: `Invalid session ID: ${recipient}` })
    }
    targetSessionID = decoded.value
    const targetSession = yield* deps.getSession(targetSessionID).pipe(
      Effect.mapError((error) => new ToolFailure({ message: `Session not found: ${targetSessionID}`, error })),
    )
    targetAgentName = targetSession.agent
  } else {
    return yield* new ToolFailure({
      message: `Unsupported recipient format: "${recipient}". Supported formats: "parent", "session:<id>", "agent:<name>", "supervisor", or "https://...".`,
    })
  }

  if (sessionID === targetSessionID) {
    return yield* new ToolFailure({
      message: `Cannot send a message to the current session itself (${sessionID}).`,
    })
  }

  const senderAddress = `session:${sessionID}`
  const formattedMessage = [
    `<incoming_message from="${senderAddress}"${params.correlation_id ? ` correlation_id="${params.correlation_id}"` : ""}>`,
    params.message,
    `</incoming_message>`,
  ].join("\n")

  if (deps.promptOps) {
    const parts = deps.promptOps.resolvePromptParts
      ? yield* deps.promptOps.resolvePromptParts(formattedMessage)
      : [{ type: "text", text: formattedMessage }]

    if (mode === "wait_reply") {
      const current = yield* deps.getSession(sessionID).pipe(
        Effect.mapError((error) => new ToolFailure({ message: `Session not found: ${sessionID}`, error })),
      )
      if (current.parentID === targetSessionID || sessionID === targetSessionID) {
        yield* deps.promptOps
          .prompt({
            sessionID: targetSessionID,
            agent: targetAgentName,
            parts,
          })
          .pipe(Effect.ignore)
        return response(
          `<message_delivery status="delivered" recipient="parent" target_session="${targetSessionID}" note="Delivered to parent inbox. Complete your turn to yield control to parent." />`,
          { target: recipient, targetSessionID, status: "delivered_to_parent" },
          `Sent message to parent ${targetSessionID}`,
        )
      }

      const result = yield* deps.promptOps.prompt({
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

    yield* deps.promptOps
      .prompt({
        sessionID: targetSessionID,
        agent: targetAgentName,
        parts,
      })
      .pipe(Effect.ignore)
    return response(
      `<message_delivery status="delivered" recipient="${recipient}" target_session="${targetSessionID}" mode="fire_and_forget" />`,
      { target: recipient, targetSessionID, status: "delivered" },
      `Sent message to ${recipient}`,
    )
  }

  if (deps.promptSession) {
    yield* deps
      .promptSession({
        sessionID: targetSessionID,
        text: formattedMessage,
      })
      .pipe(Effect.ignore)
    return response(
      `<message_delivery status="delivered" recipient="${recipient}" target_session="${targetSessionID}" mode="fire_and_forget" />`,
      { target: recipient, targetSessionID, status: "delivered" },
      `Sent message to ${recipient}`,
    )
  }

  return response(
    `<message_delivery status="queued" recipient="${recipient}" target_session="${targetSessionID}" />`,
    { target: recipient, targetSessionID, status: "queued" },
    `Message routed to ${targetSessionID}`,
  )
})

export const Plugin = {
  id: "opencode.tool.send_message",
  effect: Effect.fn("SendMessageTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description: DESCRIPTION,
          input: Input,
          output: Output,
          execute: (input, context) =>
            executeSendMessage(input, context.sessionID, new AbortController().signal, {
              getSession: (id) => sessions.get(id),
              listSessions: () => sessions.list({ parentID: context.sessionID }).pipe(Effect.map((page) => page.data)),
              createSession: (opts) =>
                sessions.create({
                  parentID: opts.parentID,
                  title: opts.title,
                  agent: Agent.ID.make(opts.agent),
                }),
              resolveAgent: (agentName) => agents.resolve(agentName),
              promptSession: (opts) => sessions.prompt({ sessionID: opts.sessionID, text: opts.text }),
              promptOps: {
                resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
                prompt: (opts) =>
                  Effect.gen(function* () {
                    const text = opts.parts.map((p) => p.text).join("\n")
                    yield* sessions.prompt({ sessionID: opts.sessionID, text }).pipe(Effect.ignore)
                    const currentSession = yield* sessions.get(context.sessionID).pipe(Effect.orElseSucceed(() => undefined))
                    const isParentOrSelf =
                      input.recipient.trim() === "parent" ||
                      opts.sessionID === context.sessionID ||
                      currentSession?.parentID === opts.sessionID
                    if ((input.mode ?? "fire_and_forget") === "wait_reply" && !isParentOrSelf) {
                      yield* sessions.wait(opts.sessionID).pipe(Effect.ignore)
                      const msgs = yield* sessions
                        .messages({ sessionID: opts.sessionID, limit: 10, order: "desc" })
                        .pipe(Effect.orElseSucceed(() => []))
                      const lastAssistant = msgs.find((m) => m.type === "assistant")
                      const replyParts =
                        lastAssistant && "content" in lastAssistant && Array.isArray(lastAssistant.content)
                          ? lastAssistant.content
                              .filter(
                                (c): c is { type: "text"; text: string } =>
                                  c.type === "text" && typeof (c as { text?: unknown }).text === "string",
                              )
                              .map((c) => ({ type: "text", text: c.text }))
                          : []
                      return { parts: replyParts }
                    }
                    return { parts: [] }
                  }),
              },
              askWebfetch: (url) =>
                permission.assert({
                  action: "webfetch",
                  resources: [url],
                  save: ["*"],
                  ...Permission.invocation(context),
                }),
            }).pipe(
              Effect.map((res) => ({
                output: {
                  title: res.title,
                  output: res.output,
                  ...res.metadata,
                },
                content: res.output,
                metadata: res.metadata,
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
