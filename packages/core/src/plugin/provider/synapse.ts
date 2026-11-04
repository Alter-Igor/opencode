import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { Credential } from "../../credential.js"
import { InstallationVersion } from "../../installation/version.js"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"
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

async function writeAuthJsonEntry(id: string, body: unknown): Promise<void> {
  const authFile = path.join(Global.Path.data, "auth.json")
  let current: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(authFile, "utf8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>
    }
  } catch {}
  current[id] = body
  await fs.mkdir(path.dirname(authFile), { recursive: true })
  await fs.writeFile(authFile, JSON.stringify(current, null, 2), { mode: 0o600 })
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

export const SynapseProviderPlugin: PluginInternal.InternalPlugin = define({
  id: "opencode.provider.synapse",
  effect: Effect.fn(function* (ctx) {
    const baseURL = process.env.SYNAPSE_BASE_URL?.trim() || DEFAULT_SYNAPSE_URL
    const privacyTier = forcedPrivacyTier()
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

    const stored = yield* Effect.promise(() => readStoredSynapseCredential().catch(() => undefined))
    const envKey = process.env.SYNAPSE_API_KEY?.trim() || process.env.GPAAS_API_KEY?.trim()
    const apiKey = stored?.token || envKey || "synapse-local"

    yield* Effect.promise(() =>
      loadSynapseModels(cfg, {
        defaultBaseURL: baseURL,
        userAgent: `opencode/${InstallationVersion}`,
        cache: fileSynapseModelsCache(),
        resolveToken: async () => (stored ? synapseModelsToken(stored) : { token: envKey, expired: false }),
      }),
    )

    const entries: Record<string, SynapseModelEntry> = cfg.provider?.[SYNAPSE_PROVIDER_ID]?.models ?? {
      [SYNAPSE_AUTO_MODEL]: defaultAutoModel(),
      ...SYNAPSE_FALLBACK_MODELS,
    }

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
      providers.update(SYNAPSE_PROVIDER_ID, (provider) => {
        provider.name = "Alterspective Synapse"
        provider.activation = "enabled"
        provider.package = "@opencode/ai/providers/openai-compatible"
        provider.settings = {
          baseURL,
          provider: SYNAPSE_PROVIDER_ID,
          apiKey,
          ...(privacyTier ? { headers: { "x-privacy-tier": privacyTier } } : {}),
        }
        provider.integrationID = integrationID
      })
      for (const [id, entry] of Object.entries(entries)) {
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
  }),
})
