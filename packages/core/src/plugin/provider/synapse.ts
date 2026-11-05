import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { Global } from "@opencode/util/global"
import { randomUUID } from "crypto"
import { Effect, Option, Stream } from "effect"
import fs from "fs/promises"
import path from "path"
import { Bus } from "../../bus.js"
import { Credential } from "../../credential.js"
import { InstallationVersion } from "../../installation/version.js"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"
import {
  SYNAPSE_AUTO_MODEL,
  SYNAPSE_FALLBACK_MODELS,
  SYNAPSE_PROVIDER_ID,
  defaultAutoModel,
  fileSynapseModelsCache,
  loadSynapseModels,
  readStoredSynapseCredential,
  type SynapseModelEntry,
  type SynapseStoredCredential,
} from "../synapse-models.js"
import {
  SYNAPSE_DEFAULT_INFERENCE_URL,
  applyPrivacyTierHeader,
  forcedPrivacyTier,
  synapseModelsToken,
} from "../synapse.js"

const DEFAULT_SYNAPSE_URL = SYNAPSE_DEFAULT_INFERENCE_URL
const ssoMethodID = Integration.MethodID.make("keystone-sso")
const integrationID = Integration.ID.make(SYNAPSE_PROVIDER_ID)

let authJsonQueue: Promise<void> = Promise.resolve()

async function writeAuthJsonEntry(id: string, body: unknown): Promise<void> {
  const next = authJsonQueue.then(async () => {
    const authFile = path.join(Global.Path.data, "auth.json")
    let current: Record<string, unknown> = {}
    try {
      const raw = await fs.readFile(authFile, "utf8")
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid auth.json root in ${authFile}`)
      }
      current = parsed as Record<string, unknown>
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err
    }
    if (body === undefined) delete current[id]
    else current[id] = body
    await fs.mkdir(path.dirname(authFile), { recursive: true })
    const tmpFile = `${authFile}.${randomUUID()}.tmp`
    await fs.writeFile(tmpFile, JSON.stringify(current, null, 2), { mode: 0o600 })
    await fs.rename(tmpFile, authFile)
  })
  authJsonQueue = next.catch(() => {})
  return next
}

const keystoneOAuth: IntegrationOAuthMethodRegistration = {
  integrationID,
  method: {
    id: ssoMethodID,
    type: "oauth",
    label: "Sign in with Keystone (Alterspective SSO)",
  },
  authorize: () =>
    Effect.tryPromise({
      try: async () => {
        const { SynapseAuthPlugin } = await import("../synapse.js")
        const hooks = await SynapseAuthPlugin({
          directory: process.cwd(),
          client: {
            auth: {
              set: async (req: { path?: { id?: string }; body?: unknown }) => {
                await writeAuthJsonEntry(req?.path?.id || SYNAPSE_PROVIDER_ID, req?.body)
                return {}
              },
            },
            tui: { showToast: async () => ({}) },
            app: { log: async () => ({}) },
          },
        } as any)
        const oauthMethod = hooks.auth?.methods.find((m) => m.type === "oauth")
        if (!oauthMethod || oauthMethod.type !== "oauth") {
          throw new Error("Synapse OAuth method unavailable")
        }
        const flow = await oauthMethod.authorize()
        return {
          mode: "auto" as const,
          url: flow.url,
          instructions: flow.instructions,
          callback: Effect.tryPromise({
            try: async () => {
              const res = await (flow.callback as (code?: string) => Promise<any>)()
              if (res.type !== "success") throw new Error("Keystone SSO sign-in failed")
              const token = "key" in res && typeof res.key === "string" ? res.key : ""
              const meta = ("metadata" in res && res.metadata ? res.metadata : {}) as Record<string, string>
              return Credential.OAuth.make({
                type: "oauth",
                methodID: ssoMethodID,
                access: token,
                refresh: meta.refreshToken || "",
                expires: Number(meta.expiresAt || Date.now() + 3600_000),
                metadata: meta,
              })
            },
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }),
        }
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
}

export const SynapseProviderPlugin = define({
  id: "opencode.provider.synapse",
  effect: Effect.fn(function* (ctx) {
    const baseURL = process.env.SYNAPSE_BASE_URL?.trim() || DEFAULT_SYNAPSE_URL
    const privacyTier = forcedPrivacyTier()
    const credentials = yield* Effect.serviceOption(Credential.Service)
    const bus = yield* Effect.serviceOption(Bus.Service)
    const persistAuthFile = !process.env.OPENCODE_AUTH_CONTENT && process.env.OPENCODE_DB !== ":memory:"

    // Seed V2 Credential.Service from existing auth.json on first run so /connect shows the existing connection.
    if (Option.isSome(credentials) && persistAuthFile) {
      const existing = yield* credentials.value.list(integrationID)
      if (existing.length === 0) {
        const seeded = yield* Effect.promise(() => readStoredSynapseCredential().catch(() => undefined))
        if (seeded?.token) {
          const value = seeded.refreshToken
            ? Credential.OAuth.make({
                type: "oauth",
                methodID: ssoMethodID,
                access: seeded.token,
                refresh: seeded.refreshToken,
                expires: seeded.expiresAt ?? Date.now() + 3600_000,
                metadata: {
                  refreshToken: seeded.refreshToken,
                  ...(seeded.expiresAt ? { expiresAt: String(seeded.expiresAt) } : {}),
                  ...(seeded.clientId ? { clientId: seeded.clientId } : {}),
                },
              })
            : Credential.Key.make({
                type: "key",
                key: seeded.token,
              })
          yield* credentials.value
            .create({
              integrationID,
              label: "Alterspective Synapse",
              value,
            })
            .pipe(Effect.ignore)
        }
      }
    }

    const readActiveCredential = Effect.gen(function* (): Effect.fn.Return<SynapseStoredCredential | undefined> {
      if (Option.isSome(credentials)) {
        const saved = yield* credentials.value.list(integrationID)
        const activeInfo = saved.at(-1)
        if (activeInfo?.value.type === "key") {
          const key = activeInfo.value.key.trim()
          if (key) {
            if (persistAuthFile) {
              const fileCred = yield* Effect.promise(() => readStoredSynapseCredential().catch(() => undefined))
              if (fileCred?.token !== key) {
                yield* Effect.promise(() =>
                  writeAuthJsonEntry(SYNAPSE_PROVIDER_ID, { type: "api", key }).catch(() => undefined),
                )
              }
            }
            return { token: key }
          }
        }
        if (activeInfo?.value.type === "oauth") {
          const oauthValue = activeInfo.value
          const token = oauthValue.access.trim()
          if (token) {
            const fileCred = yield* Effect.promise(() => readStoredSynapseCredential().catch(() => undefined))
            if (fileCred?.token && fileCred.expiresAt && fileCred.expiresAt > oauthValue.expires) {
              return fileCred
            }
            if (persistAuthFile && fileCred?.token !== token) {
              yield* Effect.promise(() =>
                writeAuthJsonEntry(SYNAPSE_PROVIDER_ID, {
                  type: "api",
                  key: token,
                  metadata: {
                    ...(oauthValue.refresh ? { refreshToken: oauthValue.refresh } : {}),
                    ...(oauthValue.expires ? { expiresAt: String(oauthValue.expires) } : {}),
                    ...oauthValue.metadata,
                  },
                }).catch(() => undefined),
              )
            }
            return {
              token,
              refreshToken: oauthValue.refresh || undefined,
              expiresAt: oauthValue.expires || undefined,
              clientId:
                typeof oauthValue.metadata?.clientId === "string" ? oauthValue.metadata.clientId : fileCred?.clientId,
              clientSecret:
                typeof oauthValue.metadata?.clientSecret === "string"
                  ? oauthValue.metadata.clientSecret
                  : fileCred?.clientSecret,
            }
          }
        }
      }
      return yield* Effect.promise(() => readStoredSynapseCredential().catch(() => undefined))
    })

    const state: {
      apiKey: string
      entries: Record<string, SynapseModelEntry>
    } = {
      apiKey: "synapse-local",
      entries: {
        [SYNAPSE_AUTO_MODEL]: defaultAutoModel(),
        ...SYNAPSE_FALLBACK_MODELS,
      },
    }

    const refreshApiKey = Effect.gen(function* () {
      const stored = yield* readActiveCredential
      const envKey = process.env.SYNAPSE_API_KEY?.trim() || process.env.GPAAS_API_KEY?.trim()
      state.apiKey = stored?.token || envKey || "synapse-local"
      return { stored, envKey }
    })

    const loadCatalog = Effect.gen(function* () {
      const cfg: any = {
        provider: {
          [SYNAPSE_PROVIDER_ID]: {
            npm: "@ai-sdk/openai-compatible",
            name: "Alterspective Synapse",
            options: { baseURL },
            models: { ...SYNAPSE_FALLBACK_MODELS },
          },
        },
      }
      if (privacyTier) applyPrivacyTierHeader(cfg, privacyTier)

      const { stored, envKey } = yield* refreshApiKey

      yield* Effect.promise(() =>
        loadSynapseModels(cfg, {
          defaultBaseURL: baseURL,
          userAgent: `opencode/${InstallationVersion}`,
          cache: fileSynapseModelsCache(),
          resolveToken: async () => (stored ? synapseModelsToken(stored) : { token: envKey, expired: false }),
        }),
      )

      state.entries = cfg.provider?.[SYNAPSE_PROVIDER_ID]?.models ?? {
        [SYNAPSE_AUTO_MODEL]: defaultAutoModel(),
        ...SYNAPSE_FALLBACK_MODELS,
      }
    })

    yield* loadCatalog

    yield* ctx.integration.transform((integrations) => {
      integrations.update(SYNAPSE_PROVIDER_ID, (integration) => {
        integration.name = "Alterspective Synapse"
      })
      integrations.method.update(keystoneOAuth)
      integrations.method.update({
        integrationID: SYNAPSE_PROVIDER_ID,
        method: { type: "key", label: "Paste Synapse API Key" },
      })
      integrations.method.update({
        integrationID: SYNAPSE_PROVIDER_ID,
        method: { type: "env", names: ["SYNAPSE_API_KEY", "GPAAS_API_KEY"] },
      })
    })

    yield* ctx.provider.transform((providers) => {
      // Restrict unconnected OOB public/free fallback on opencode unless connected via /connect or OPENCODE_API_KEY.
      if (process.env.OPENCODE_ALLOW_UNCONNECTED_FREE_MODELS !== "1") {
        const opencode = providers.get(Provider.ID.opencode)
        if (opencode?.provider.settings?.apiKey === "public" && opencode.provider.activation === "enabled") {
          providers.update(Provider.ID.opencode, (provider) => {
            provider.activation = "auto"
          })
        }
      }
      providers.update(SYNAPSE_PROVIDER_ID, (provider) => {
        provider.name = "Alterspective Synapse"
        provider.activation = "enabled"
        provider.package = "@opencode/ai/providers/openai-compatible"
        provider.settings = {
          baseURL,
          provider: SYNAPSE_PROVIDER_ID,
          apiKey: state.apiKey,
          ...(privacyTier ? { headers: { "x-privacy-tier": privacyTier } } : {}),
        }
        provider.integrationID = integrationID
      })
      for (const [id, entry] of Object.entries(state.entries)) {
        providers.models.update(SYNAPSE_PROVIDER_ID, id, (model) => {
          model.modelID = Model.ID.make(id)
          model.name = entry.name || id
          model.family = Model.Family.make("synapse")
          model.capabilities = {
            tools: entry.tool_call ?? true,
            input: ["text"],
            output: entry.reasoning ? ["text", "reasoning"] : ["text"],
          }
          if (entry.limit?.context) model.limit.context = entry.limit.context
          if (entry.limit?.output) model.limit.output = entry.limit.output
        })
      }
    })

    yield* ctx.model.transform((models) => {
      if (!models.default.get()) {
        models.default.set(Provider.ID.make(SYNAPSE_PROVIDER_ID), Model.ID.make(SYNAPSE_AUTO_MODEL))
      }
    })

    if (Option.isSome(bus)) {
      yield* bus.value
        .subscribe(Credential.Event.Switched)
        .pipe(
          Stream.filter((event) => event.data.integrationID === SYNAPSE_PROVIDER_ID),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.data.credentialID === null && persistAuthFile) {
                yield* Effect.promise(() => writeAuthJsonEntry(SYNAPSE_PROVIDER_ID, undefined).catch(() => undefined))
              }
              yield* refreshApiKey
              yield* ctx.provider.reload()
              yield* loadCatalog
              yield* ctx.provider.reload()
              yield* ctx.model.reload()
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
    }
  }),
} satisfies PluginInternal.InternalPlugin)
