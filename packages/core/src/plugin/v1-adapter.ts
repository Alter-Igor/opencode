import { SystemPart } from "@opencode/ai/effect"
import { tool, type Config, type Hooks, type PluginInput } from "@opencode/plugin"
import { define } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Cause, Effect, Exit, Option, Scope, Stream } from "effect"
import fs from "fs/promises"
import { parse, type ParseError } from "jsonc-parser"
import path from "path"
import { Credential } from "../credential.js"
import { Integration } from "../integration.js"
import {
  SYNAPSE_DEFAULT_CONTEXT,
  SYNAPSE_PROVIDER_ID,
  isSynapseRefreshSuccessor,
  readStoredSynapseCredential,
  writeAuthJsonEntry,
} from "./synapse-models.js"
import { SYNAPSE_DEFAULT_INFERENCE_URL } from "./synapse.js"

export type V1PluginFn = (input: PluginInput) => Promise<Hooks>

export function fromLegacyV1Plugin(id: string, fn: V1PluginFn) {
  return define({
    id,
    effect: Effect.fn(function* (ctx) {
      const scope = yield* Scope.Scope
      const runtime = yield* Effect.context<never>()
      const clientStub = {
        auth: {
          set: async (req: { path?: { id?: string }; body?: unknown }) => {
            const providerId = req?.path?.id || SYNAPSE_PROVIDER_ID
            await writeAuthJsonEntry(providerId, req?.body, { fromRefresh: true })
            return {}
          },
        },
        tui: {
          showToast: async () => ({}),
        },
        app: {
          log: async () => ({}),
        },
      }

      const hooks: Hooks = yield* Effect.promise(() =>
        fn({
          directory: ctx.location.directory,
          worktree: ctx.location.directory,
          project: {
            id: "default",
            worktree: ctx.location.directory,
            time: { created: Date.now() },
          } as any,
          client: clientStub as any,
          serverUrl: new URL("http://127.0.0.1:4096"),
          $: (globalThis as any).Bun?.$ as any,
        }),
      ).pipe(Effect.orElseSucceed((): Hooks => ({})))

      const dispose = (hooks as { dispose?: () => unknown }).dispose
      if (typeof dispose === "function") {
        yield* Scope.addFinalizer(
          scope,
          Effect.promise(async () => {
            await dispose()
          }),
        )
      }

      if (hooks.config) {
        const baseURL = process.env.SYNAPSE_BASE_URL?.trim() || SYNAPSE_DEFAULT_INFERENCE_URL
        const isSynapseAuthPlugin = id === "opencode.plugin.synapse" || id === "opencode.fork.synapse-auth"
        const cfg: Config = {
          provider: isSynapseAuthPlugin
            ? {}
            : {
                [SYNAPSE_PROVIDER_ID]: {
                  options: { baseURL },
                },
              },
        }
        yield* Effect.promise(async () => {
          for (const candidate of [
            "opencode.json",
            "opencode.jsonc",
            ".opencode/opencode.json",
            ".opencode/opencode.jsonc",
          ]) {
            try {
              const raw = await fs.readFile(path.join(ctx.location.directory, candidate), "utf8")
              const errors: ParseError[] = []
              const parsed = parse(raw, errors, { allowTrailingComma: true })
              if (errors.length === 0 && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                if (parsed.experimental && typeof parsed.experimental === "object") {
                  ;(cfg as any).experimental = parsed.experimental
                }
                if (Array.isArray(parsed.disabled_providers)) {
                  cfg.disabled_providers = parsed.disabled_providers
                }
                if (Array.isArray(parsed.enabled_providers)) {
                  cfg.enabled_providers = parsed.enabled_providers
                }
                if (isSynapseAuthPlugin && parsed.provider?.synapse && typeof parsed.provider.synapse === "object") {
                  cfg.provider = { ...cfg.provider, [SYNAPSE_PROVIDER_ID]: parsed.provider.synapse }
                }
                break
              }
            } catch {}
          }
          await hooks.config!(cfg)
        }).pipe(Effect.ignore)
        const commands = Object.entries(cfg.command ?? {})
        if (commands.length > 0) {
          yield* ctx.command.transform((editor) => {
            for (const [name, cmd] of commands) {
              if (!cmd?.template) continue
              if ((editor as { get?: (n: string) => unknown }).get?.(name)) continue
              const template = cmd.template
              editor.add({
                name,
                description: cmd.description,
                execute: (input) =>
                  ctx.session
                    .prompt({
                      ...input.prompt,
                      sessionID: input.sessionID,
                      text: template.includes("$ARGUMENTS")
                        ? template.replaceAll("$ARGUMENTS", () => input.prompt.text.trim())
                        : [template, input.prompt.text.trim()].filter(Boolean).join("\n\n"),
                      delivery: input.delivery,
                    })
                    .pipe(Effect.asVoid),
              })
            }
          })
        }
      }

      if (hooks.tool) {
        const toolDefs = Object.entries(hooks.tool)
        if (toolDefs.length > 0) {
          yield* ctx.tool.transform((editor) => {
            for (const [name, def] of toolDefs) {
              if (!def) continue
              editor.add({
                name,
                description: def.description,
                input: tool.schema.object(def.args ?? {}),
                options: { codemode: false },
                execute: (args, toolCtx) =>
                  Effect.tryPromise({
                    try: async (signal) => {
                      const res = await def.execute(args as any, {
                        sessionID: toolCtx.sessionID,
                        messageID: toolCtx.messageID,
                        agent: toolCtx.agent,
                        directory: ctx.location.directory,
                        worktree: ctx.location.directory,
                        abort: signal,
                        metadata: (metaInput) => {
                          void Effect.runPromiseWith(runtime)(
                            toolCtx.progress({
                              ...(metaInput.title ? { title: metaInput.title } : {}),
                              ...(metaInput.metadata ?? {}),
                            }),
                          ).catch(() => undefined)
                        },
                        ask: async (askInput) => {
                          const exit = await Effect.runPromiseExitWith(runtime)(
                            ctx.permission.assert({
                              action: askInput.permission,
                              resources: askInput.patterns,
                              save: askInput.always,
                              metadata: askInput.metadata,
                              sessionID: toolCtx.sessionID,
                              agent: toolCtx.agent,
                              source: {
                                type: "tool",
                                id: toolCtx.id,
                                messageID: toolCtx.messageID,
                              },
                            }),
                          )
                          if (Exit.isFailure(exit)) {
                            throw Cause.squash(exit.cause)
                          }
                        },
                      })
                      if (typeof res === "string") {
                        return { content: res, output: res }
                      }
                      const attachments = res.attachments ?? []
                      return {
                        content:
                          attachments.length > 0
                            ? [
                                { type: "text" as const, text: res.output },
                                ...attachments.map((a) => ({
                                  type: "file" as const,
                                  uri: a.url,
                                  mime: a.mime,
                                  ...(a.filename ? { name: a.filename } : {}),
                                })),
                              ]
                            : res.output,
                        output: res.output,
                        metadata: {
                          ...(res.title ? { title: res.title } : {}),
                          ...(res.metadata ?? {}),
                        },
                      }
                    },
                    catch: (err) =>
                      err instanceof Tool.Error
                        ? err
                        : new Tool.Error({
                            message: err instanceof Error ? err.message : String(err),
                            error: err,
                          }),
                  }),
              })
            }
          })
        }
      }

      if (hooks["tool.definition"] || hooks["experimental.chat.system.transform"]) {
        const toolDefHook = hooks["tool.definition"]
        const systemTransform = hooks["experimental.chat.system.transform"]
        yield* ctx.session.hook("context", (evt) =>
          Effect.gen(function* () {
            if (toolDefHook && evt.tools) {
              yield* Effect.promise(async () => {
                for (const [toolID, def] of Object.entries(evt.tools)) {
                  const out = { description: def.description, parameters: def.input }
                  await toolDefHook({ toolID }, out)
                  def.description = out.description
                  def.input = out.parameters
                }
              })
            }
            if (systemTransform) {
              const rawModel = evt.model as any
              const fallbackContext = rawModel?.providerID === SYNAPSE_PROVIDER_ID ? SYNAPSE_DEFAULT_CONTEXT : 0
              let contextLimit: number | undefined = rawModel?.limit?.context
              if (
                contextLimit === undefined &&
                id === "opencode.fork.small-model-delegation" &&
                rawModel?.providerID &&
                (rawModel?.id || rawModel?.modelID)
              ) {
                const targetId = rawModel.id ?? rawModel.modelID
                const modelsRes = yield* ctx.model.list().pipe(Effect.orElseSucceed(() => undefined))
                const modelsList: readonly any[] = Array.isArray(modelsRes)
                  ? modelsRes
                  : ((modelsRes as any)?.data ?? (modelsRes as any)?.models ?? [])
                const matched = modelsList.find(
                  (m: any) => m.providerID === rawModel.providerID && (m.id === targetId || m.modelID === targetId),
                )
                contextLimit = (matched as any)?.limit?.context ?? fallbackContext
              }
              const sessionInfo = evt.sessionID
                ? yield* ctx.session.get({ sessionID: evt.sessionID }).pipe(Effect.orElseSucceed(() => undefined))
                : undefined
              yield* Effect.promise(async () => {
                const prevByText = new Map(evt.system.map((s) => [s.text, s]))
                const out = { system: evt.system.map((s) => s.text) }
                await systemTransform(
                  {
                    sessionID: evt.sessionID,
                    parentSessionID: (sessionInfo as { parentID?: string } | undefined)?.parentID,
                    agent: evt.agent,
                    model: {
                      ...rawModel,
                      id: rawModel?.id ?? rawModel?.modelID ?? "",
                      providerID: rawModel?.providerID ?? "",
                      limit: { context: contextLimit ?? fallbackContext, output: rawModel?.limit?.output ?? 16_384 },
                    } as any,
                  },
                  out,
                )
                evt.system.splice(
                  0,
                  evt.system.length,
                  ...out.system.map((text) => {
                    const existing = prevByText.get(text)
                    return existing ? existing : SystemPart.make(text)
                  }),
                )
              })
            }
          }),
        )
      }

      if (hooks["chat.headers"]) {
        const chatHeaders = hooks["chat.headers"]
        yield* ctx.session.hook("model.request", (evt) =>
          Effect.promise(async () => {
            const rawModel = evt.model as any
            const out = { headers: { ...evt.headers } }
            await chatHeaders(
              {
                sessionID: evt.sessionID,
                agent: evt.agent,
                model: {
                  ...rawModel,
                  id: rawModel?.id ?? rawModel?.modelID ?? "",
                  providerID: rawModel?.providerID ?? "",
                } as any,
                provider: {} as any,
                message: {} as any,
              },
              out,
            )
            Object.assign(evt.headers, out.headers)
          }),
        )
      }

      if (hooks["shell.env"]) {
        const shellEnv = hooks["shell.env"]
        yield* ctx.shell.hook("create.before", (evt) =>
          Effect.promise(async () => {
            const out = { env: { ...(evt.env as Record<string, string>) } }
            await shellEnv({ cwd: evt.cwd }, out)
            Object.assign(evt.env, out.env)
          }),
        )
      }

      if (hooks.event || hooks["experimental.text.complete"]) {
        const onEvent = hooks.event
        const onTextComplete = hooks["experimental.text.complete"]
        const toolNameByCallId = new Map<string, string>()
        yield* ctx.event
          .subscribe()
          .pipe(
            Stream.runForEach((raw) =>
              Effect.promise(async () => {
                const ev = raw as { id?: string; type: string; data?: Record<string, any> }
                const data = ev.data ?? {}
                if (ev.type === "session.tool.input.started" && data.id && data.name) {
                  toolNameByCallId.set(String(data.id), String(data.name))
                } else if (ev.type === "session.tool.success" && data.id) {
                  toolNameByCallId.delete(String(data.id))
                }
                if (onTextComplete && ev.type === "session.text.ended") {
                  await onTextComplete(
                    {
                      sessionID: String(data.sessionID ?? ""),
                      messageID: String(data.assistantMessageID ?? ""),
                      partID: String(ev.id ?? data.assistantMessageID ?? ""),
                    },
                    { text: String(data.text ?? "") },
                  ).catch(() => undefined)
                }
                if (onEvent) {
                  await onEvent({ event: { type: ev.type, properties: data } }).catch(() => undefined)
                  if (ev.type === "session.execution.succeeded") {
                    await onEvent({ event: { type: "session.idle", properties: data } }).catch(() => undefined)
                  } else if (ev.type === "session.tool.failed") {
                    const callId = String(data.id ?? "")
                    const toolName = String(data.name ?? data.tool ?? toolNameByCallId.get(callId) ?? "")
                    toolNameByCallId.delete(callId)
                    const errText =
                      typeof data.error === "string"
                        ? data.error
                        : typeof data.error?.message === "string"
                          ? data.error.message
                          : String(data.error ?? "Tool execution failed")
                    await onEvent({
                      event: {
                        type: "message.part.updated",
                        properties: {
                          part: {
                            id: callId,
                            callID: callId,
                            sessionID: String(data.sessionID ?? ""),
                            messageID: String(data.assistantMessageID ?? ""),
                            type: "tool",
                            tool: toolName,
                            state: { status: "error", error: errText },
                          },
                        },
                      },
                    }).catch(() => undefined)
                  }
                }
              }),
            ),
            Effect.ignore,
            Effect.forkIn(scope, { startImmediately: true }),
          )
      }

      if (hooks["tool.execute.before"]) {
        const before = hooks["tool.execute.before"]
        yield* ctx.tool.hook("execute.before", (evt) =>
          Effect.tryPromise({
            try: async () => {
              const out = { args: evt.input as any }
              await before(
                { tool: evt.tool, sessionID: evt.sessionID, callID: evt.id, messageID: evt.messageID } as any,
                out,
              )
              evt.input = out.args
            },
            catch: (err) => new Tool.Error({ message: err instanceof Error ? err.message : String(err) }),
          }),
        )
      }

      if (hooks["tool.execute.after"]) {
        const after = hooks["tool.execute.after"]
        yield* ctx.tool.hook("execute.after", (evt) =>
          Effect.promise(async () => {
            if (evt.status !== "completed") return
            const content = evt.result.content
            const firstText = Array.isArray(content)
              ? content.find((c: { type: string; text?: string }) => c.type === "text")
              : undefined
            const out: { title: string; output: string; metadata: any; content?: unknown } = {
              title: (evt.result as { title?: string }).title ?? "",
              output:
                typeof content === "string"
                  ? content
                  : firstText && "text" in firstText && typeof firstText.text === "string"
                    ? firstText.text
                    : typeof evt.result.output === "string"
                      ? evt.result.output
                      : "",
              metadata: (evt.result.metadata ?? {}) as any,
              ...(Array.isArray(content) ? { content } : {}),
            }
            await after(
              {
                tool: evt.tool,
                sessionID: evt.sessionID,
                callID: evt.id,
                messageID: evt.messageID,
                args: evt.input,
              } as any,
              out,
            )
            ;(evt.result as { metadata?: unknown }).metadata = out.metadata
            if (typeof evt.result.content === "string") {
              ;(evt.result as { content?: unknown }).content = out.output
            } else if (firstText && "text" in firstText && out.output !== firstText.text) {
              ;(firstText as any).text = out.output
            }
            if (typeof evt.result.output === "string") {
              ;(evt.result as { output?: unknown }).output = out.output
            } else if (evt.result.output && typeof evt.result.output === "object") {
              const { redactToolResult } = await import("../util/secret-redaction.js")
              redactToolResult(evt.result as { output?: unknown })
            }
          }),
        )
      }

      if (hooks.auth?.loader) {
        const authHook = hooks.auth
        const credentials = yield* Effect.serviceOption(Credential.Service)
        let lastBearerKey: string | undefined
        const getAuth = async () => {
          const stored = await readStoredSynapseCredential().catch(() => undefined)
          const envKey = process.env.SYNAPSE_API_KEY?.trim() || process.env.GPAAS_API_KEY?.trim()
          if (authHook.provider === SYNAPSE_PROVIDER_ID && Option.isSome(credentials)) {
            const saved = await Effect.runPromiseWith(runtime)(
              credentials.value.list(Integration.ID.make(SYNAPSE_PROVIDER_ID)),
            ).catch(() => [])
            const active = saved.at(-1)?.value
            if (active?.type === "key" && active.key.trim()) {
              return { type: "api" as const, key: active.key.trim() } as any
            }
            if (active?.type === "oauth" && active.access.trim()) {
              if (isSynapseRefreshSuccessor(stored, active)) {
                return {
                  type: "oauth" as const,
                  key: stored.token,
                  access: stored.token,
                  refresh: stored.refreshToken,
                  expires: stored.expiresAt ?? 0,
                  metadata: {
                    refreshToken: stored.refreshToken,
                    expiresAt: stored.expiresAt ? String(stored.expiresAt) : undefined,
                    clientId: stored.clientId,
                    clientSecret: stored.clientSecret,
                  },
                } as any
              }
              return {
                type: "oauth" as const,
                key: active.access.trim(),
                access: active.access.trim(),
                refresh: active.refresh,
                expires: active.expires,
                metadata: {
                  refreshToken: active.refresh || undefined,
                  expiresAt: active.expires ? String(active.expires) : undefined,
                  ...active.metadata,
                },
              } as any
            }
          }
          if (stored?.token) {
            return {
              type: (stored.refreshToken ? "oauth" : "api") as "oauth" | "api",
              key: stored.token,
              access: stored.token,
              refresh: stored.refreshToken ?? "",
              expires: stored.expiresAt ?? 0,
              metadata: {
                refreshToken: stored.refreshToken,
                expiresAt: stored.expiresAt ? String(stored.expiresAt) : undefined,
                clientId: stored.clientId,
                clientSecret: stored.clientSecret,
              },
            } as any
          }
          if (envKey) {
            return { type: "api" as const, key: envKey } as any
          }
          if (authHook.provider === SYNAPSE_PROVIDER_ID) {
            return { type: "api" as const, key: lastBearerKey || "synapse-local" } as any
          }
          return undefined as any
        }
        let loadedPromise: Promise<Record<string, any>> | undefined
        yield* ctx.session.hook(
          "http.request",
          (evt) =>
            Effect.promise(async () => {
              const authHeader = evt.request.headers.get("authorization")
              const bearer = authHeader?.replace(/^Bearer\s+/i, "").trim()
              lastBearerKey =
                bearer && bearer !== "oauth-synapse-bearer" && bearer !== "synapse-local" ? bearer : undefined
              loadedPromise ??= authHook.loader!(getAuth, {} as any)
              const loaded = await loadedPromise.catch((err) => {
                loadedPromise = undefined
                throw err
              })
              if (loaded?.headers && typeof loaded.headers === "object") {
                for (const [k, v] of Object.entries(loaded.headers as Record<string, string>)) {
                  if (typeof v === "string" && (k.toLowerCase() === "x-privacy-tier" || !evt.request.headers.has(k))) {
                    evt.request.headers.set(k, v)
                  }
                }
              }
              if (typeof loaded?.fetch === "function") {
                const cloned = evt.request.clone()
                const bodyText = cloned.method !== "GET" && cloned.method !== "HEAD" ? await cloned.text() : undefined
                evt.response = await loaded.fetch(evt.request.url, {
                  method: evt.request.method,
                  headers: evt.request.headers,
                  body: bodyText,
                  signal: evt.request.signal,
                })
              } else {
                loadedPromise = undefined
              }
            }),
          { providerID: authHook.provider },
        )
      }
    }),
  })
}
