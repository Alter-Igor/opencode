import { SystemPart } from "@opencode/ai/effect"
import type { Hooks, PluginInput } from "@opencode/plugin"
import { define } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import type { PluginInternal } from "./internal.js"
import { readStoredSynapseCredential } from "./synapse-models.js"

export type V1PluginFn = (input: PluginInput) => Promise<Hooks>

export function fromLegacyV1Plugin(id: string, fn: V1PluginFn): PluginInternal.InternalPlugin {
  return define({
    id,
    effect: Effect.fn(function* (ctx) {
      const hooks: Hooks = yield* Effect.promise(() =>
        fn({
          directory: ctx.location.directory,
          worktree: ctx.location.directory,
          project: {
            id: "default",
            worktree: ctx.location.directory,
            time: { created: Date.now() },
          } as any,
          client: {} as any,
          serverUrl: new URL("http://127.0.0.1:4096"),
          $: (globalThis as any).Bun?.$ as any,
        }),
      ).pipe(Effect.orElseSucceed((): Hooks => ({})))

      if (hooks.config && id === "opencode.fork.opencodealt-docs") {
        const cfg: { command?: Record<string, { description?: string; template?: string }> } = {}
        yield* Effect.promise(() => hooks.config!(cfg as any)).pipe(Effect.ignore)
        const commands = Object.entries(cfg.command ?? {})
        if (commands.length > 0) {
          yield* ctx.command.transform((editor) => {
            for (const [name, cmd] of commands) {
              if (!cmd?.template) continue
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

      if (hooks["experimental.chat.system.transform"]) {
        const transform = hooks["experimental.chat.system.transform"]
        yield* ctx.session.hook("context", (evt) =>
          Effect.promise(async () => {
            const out = { system: evt.system.map((s) => s.text) }
            await transform({ sessionID: evt.sessionID, model: evt.model as any }, out)
            if (out.system.length > evt.system.length) {
              for (const extra of out.system.slice(evt.system.length)) {
                evt.system.push(SystemPart.make(extra))
              }
            }
          }),
        )
      }

      if (hooks["chat.headers"]) {
        const chatHeaders = hooks["chat.headers"]
        yield* ctx.session.hook("model.request", (evt) =>
          Effect.promise(async () => {
            const out = { headers: { ...evt.headers } }
            await chatHeaders(
              {
                sessionID: evt.sessionID,
                agent: evt.agent,
                model: evt.model as any,
                provider: {} as any,
                message: {} as any,
              },
              out,
            )
            Object.assign(evt.headers, out.headers)
          }),
        )
      }

      if (hooks["tool.execute.before"]) {
        const before = hooks["tool.execute.before"]
        yield* ctx.tool.hook("execute.before", (evt) =>
          Effect.tryPromise({
            try: async () => {
              const out = { args: evt.input as any }
              await before({ tool: evt.tool, sessionID: evt.sessionID, callID: evt.id }, out)
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
            const out = {
              title: (evt.result as { title?: string }).title ?? "",
              output:
                typeof content === "string"
                  ? content
                  : firstText && "text" in firstText && typeof firstText.text === "string"
                    ? firstText.text
                    : "",
              metadata: (evt.result.metadata ?? {}) as any,
            }
            await after({ tool: evt.tool, sessionID: evt.sessionID, callID: evt.id, args: evt.input }, out)
            if (firstText && "text" in firstText && out.output !== firstText.text) {
              ;(firstText as any).text = out.output
            }
          }),
        )
      }

      if (hooks.auth?.loader) {
        const authHook = hooks.auth
        yield* ctx.session.hook(
          "http.request",
          (evt) =>
            Effect.promise(async () => {
              const getAuth = async () => {
                const stored = await readStoredSynapseCredential().catch(() => undefined)
                const envKey = process.env.SYNAPSE_API_KEY?.trim() || process.env.GPAAS_API_KEY?.trim()
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
                return undefined as any
              }
              const loaded = await authHook.loader!(getAuth, {} as any)
              if (typeof loaded?.fetch === "function") {
                const cloned = evt.request.clone()
                const bodyText = cloned.method !== "GET" && cloned.method !== "HEAD" ? await cloned.text() : undefined
                evt.response = await loaded.fetch(evt.request.url, {
                  method: evt.request.method,
                  headers: evt.request.headers,
                  body: bodyText,
                  signal: evt.request.signal,
                })
              }
            }),
          { providerID: authHook.provider },
        )
      }
    }),
  })
}
