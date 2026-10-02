// Fork-only: load the `synapse` provider's model list from the Synapse gateway at startup.
//
// The gateway's OpenAI-compatible `GET <baseURL>/models` is the source of truth for
// which models exist. A hand-typed `provider.synapse.models` in a user's config goes
// stale as Synapse adds and retires models, so the live list REPLACES it; the
// configured list is kept only as the fallback when the gateway cannot be reached.
// `auto` is Synapse's routing alias. It is never in the gateway's list, so it is
// always added.
//
// OPENCODE_DISABLE_MODELS_FETCH is deliberately NOT honoured here. That flag gates the
// models.dev catalogue download (core/src/models-dev.ts); Synapse's own list is a
// different source, and the delegate box sets that flag while still needing the live
// Synapse list.
import * as fs from "fs/promises"
import * as path from "path"
import type { Config } from "@opencode-ai/plugin"
import { Global } from "@opencode-ai/core/global"

export const SYNAPSE_PROVIDER_ID = "synapse"
export const SYNAPSE_AUTO_MODEL = "auto"
export const SYNAPSE_MODELS_TIMEOUT_MS = 5_000
export const SYNAPSE_DEFAULT_CONTEXT = 128_000
export const SYNAPSE_DEFAULT_OUTPUT = 16_384

type ProviderEntry = NonNullable<Config["provider"]>[string]
export type SynapseModelEntry = NonNullable<ProviderEntry["models"]>[string]

export type SynapseModelsFetch = (url: string, init: RequestInit) => Promise<Response>

export interface SynapseModelsLogEvent {
  reason: "synapse-models-fetch-failed"
  url: string
  error: string
}

export interface SynapseModelsDeps {
  defaultBaseURL: string
  fetch?: SynapseModelsFetch
  readStoredToken?: () => Promise<string | undefined>
  log?: (event: SynapseModelsLogEvent) => void
  timeoutMs?: number
  userAgent?: string
}

export type SynapseModelsResult = "live" | "fallback" | "skipped"

export function synapseModelsUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/models`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

// The gateway reports reasoning as a mode string ("none" | "field" | ...) or a boolean.
function reasoningEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value
  return typeof value === "string" && value !== "" && value !== "none"
}

function modelFromItem(item: Record<string, unknown>): SynapseModelEntry {
  const caps = isRecord(item.capabilities) ? item.capabilities : {}
  return {
    name: String(item.id),
    tool_call: typeof caps.tools === "boolean" ? caps.tools : true,
    reasoning: reasoningEnabled(caps.reasoning),
    limit: {
      context: positiveInt(item.contextWindow) ?? SYNAPSE_DEFAULT_CONTEXT,
      output: positiveInt(item.maxOutput) ?? SYNAPSE_DEFAULT_OUTPUT,
    },
  }
}

/** Map an OpenAI-compatible `/models` reply to config model entries, chat models only. */
export function parseSynapseModelList(body: unknown): Record<string, SynapseModelEntry> {
  const items = isRecord(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : []
  const models: Record<string, SynapseModelEntry> = {}
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id === "") continue
    const caps = isRecord(item.capabilities) ? item.capabilities : undefined
    if (caps && Array.isArray(caps.ops) && !caps.ops.includes("chat")) continue
    models[item.id] = modelFromItem(item)
  }
  return models
}

function defaultAutoModel(): SynapseModelEntry {
  return {
    name: "Synapse Auto",
    tool_call: true,
    limit: { context: SYNAPSE_DEFAULT_CONTEXT, output: SYNAPSE_DEFAULT_OUTPUT },
  }
}

/** The stored `synapse` credential, read the same way the Auth service reads it. */
export async function readStoredSynapseToken(): Promise<string | undefined> {
  let data: unknown
  try {
    data = process.env.OPENCODE_AUTH_CONTENT
      ? JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
      : JSON.parse(await fs.readFile(path.join(Global.Path.data, "auth.json"), "utf8"))
  } catch {
    return undefined
  }
  const entry = isRecord(data) ? data[SYNAPSE_PROVIDER_ID] : undefined
  if (!isRecord(entry)) return undefined
  const token = entry.type === "api" ? entry.key : entry.type === "oauth" ? entry.access : undefined
  return typeof token === "string" && token !== "" ? token : undefined
}

function stringHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, header] of Object.entries(value)) if (typeof header === "string") out[key] = header
  return out
}

function errorText(error: unknown, token: string | undefined): string {
  const text = error instanceof Error ? error.message : String(error)
  return token ? text.split(token).join("[REDACTED]") : text
}

/**
 * Replace `cfg.provider.synapse.models` with the gateway's live list plus `auto`.
 * On any failure the configured models are kept, `auto` is added, and one event is
 * logged. Never throws, and waits at most `timeoutMs` for the gateway.
 */
export async function loadSynapseModels(cfg: Config, deps: SynapseModelsDeps): Promise<SynapseModelsResult> {
  const provider = cfg.provider?.[SYNAPSE_PROVIDER_ID]
  if (!provider) return "skipped"

  const options = provider.options ?? {}
  const baseURL = typeof options.baseURL === "string" && options.baseURL ? options.baseURL : deps.defaultBaseURL
  const url = synapseModelsUrl(baseURL)
  const configured = provider.models ?? {}
  const auto = configured[SYNAPSE_AUTO_MODEL] ?? defaultAutoModel()

  let token: string | undefined
  try {
    const stored = await (deps.readStoredToken ?? readStoredSynapseToken)()
    const configuredKey = typeof options.apiKey === "string" && options.apiKey ? options.apiKey : undefined
    token = stored ?? configuredKey

    const headers = new Headers(stringHeaders(options.headers))
    headers.set("accept", "application/json")
    if (deps.userAgent) headers.set("user-agent", deps.userAgent)
    // Same credential headers the chat path sends. With no token (the delegate box)
    // the request still goes out, and the front proxy injects the credential.
    if (token) {
      headers.set("authorization", `Bearer ${token}`)
      headers.set("x-api-key", token)
    }

    const response = await (deps.fetch ?? fetch)(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(deps.timeoutMs ?? SYNAPSE_MODELS_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const live = parseSynapseModelList(await response.json())
    if (Object.keys(live).length === 0) throw new Error("gateway returned no chat models")

    provider.models = { ...live, [SYNAPSE_AUTO_MODEL]: auto }
    return "live"
  } catch (error) {
    provider.models = { ...configured, [SYNAPSE_AUTO_MODEL]: auto }
    deps.log?.({ reason: "synapse-models-fetch-failed", url, error: errorText(error, token) })
    return "fallback"
  }
}
