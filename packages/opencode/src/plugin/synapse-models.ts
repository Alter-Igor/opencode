// Fork-only: load the `synapse` provider's model list from the Synapse gateway at startup.
//
// The gateway's OpenAI-compatible `GET <baseURL>/models` is the source of truth for
// which models exist. A hand-typed `provider.synapse.models` in a user's config goes
// stale as Synapse adds and retires models, so the live list REPLACES it. When the
// gateway cannot be reached, the last good live list (cached on disk, no token in it)
// is used, and only without a cache the configured list. `auto` is Synapse's routing
// alias. It is never in the gateway's list, so it is always added.
//
// OPENCODE_DISABLE_MODELS_FETCH is deliberately NOT honoured here. That flag gates the
// models.dev catalogue download (core/src/models-dev.ts); Synapse's own list is a
// different source, and the delegate box sets that flag while still needing the live
// Synapse list.
//
// Startup never refreshes a Keystone token: Keystone revokes the whole login when a
// refresh token is reused, and the model list does not need that risk. With a stored
// access token that is already expired, startup skips the fetch and uses the cache
// (or the configured list). After a chat-time refresh succeeds, synapse.ts updates
// the cache in the background with the new token (updateSynapseModelsCache). The
// refresh single-flight guard in synapse.ts is per process.
//
// This runs from the Synapse plugin's `config` hook. OPENCODE_DISABLE_DEFAULT_PLUGINS
// turns all internal plugins off, so with it set nothing here runs: no live list and
// no `auto`, only what the config file lists.
import * as fs from "fs/promises"
import * as path from "path"
import type { Config } from "@opencode-ai/plugin"
import { Global } from "@opencode-ai/core/global"

export const SYNAPSE_PROVIDER_ID = "synapse"
export const SYNAPSE_AUTO_MODEL = "auto"
export const SYNAPSE_MODELS_TIMEOUT_MS = 2_500
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

/** Last good live list per base URL. Holds model metadata only, never a credential. */
export interface SynapseModelsCache {
  read: (baseURL: string) => Promise<Record<string, SynapseModelEntry> | undefined>
  write: (baseURL: string, models: Record<string, SynapseModelEntry>) => Promise<void>
}

/** The stored `synapse` credential, with what is needed to refresh it. */
export interface SynapseStoredCredential {
  token: string
  refreshToken?: string
  /** Epoch milliseconds. */
  expiresAt?: number
  clientId?: string
  clientSecret?: string
}

export interface SynapseModelsDeps {
  defaultBaseURL: string
  fetch?: SynapseModelsFetch
  /** The stored token, and whether it is already expired (then no fetch is made). */
  resolveToken?: () => Promise<{ token?: string; expired: boolean }>
  log?: (event: SynapseModelsLogEvent) => void
  cache?: SynapseModelsCache
  timeoutMs?: number
  userAgent?: string
}

export type SynapseModelsResult = "live" | "cache" | "fallback" | "skipped"

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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function optionalEpochMs(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

async function readAuthData(file: string): Promise<unknown> {
  // Same order as the Auth service (auth/index.ts): OPENCODE_AUTH_CONTENT when it
  // parses, otherwise the auth file.
  if (process.env.OPENCODE_AUTH_CONTENT) {
    try {
      return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
    } catch {}
  }
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

/** The stored `synapse` credential, read the same way the Auth service reads it. */
export async function readStoredSynapseCredential(
  file: string = path.join(Global.Path.data, "auth.json"),
): Promise<SynapseStoredCredential | undefined> {
  const data = await readAuthData(file)
  const entry = isRecord(data) ? data[SYNAPSE_PROVIDER_ID] : undefined
  if (!isRecord(entry)) return undefined
  const meta = isRecord(entry.metadata) ? entry.metadata : {}
  const oauth = entry.type === "oauth"
  const token = optionalString(entry.type === "api" ? entry.key : oauth ? entry.access : undefined)
  if (!token) return undefined
  return {
    token,
    refreshToken: optionalString(meta.refreshToken) ?? (oauth ? optionalString(entry.refresh) : undefined),
    expiresAt: optionalEpochMs(meta.expiresAt) ?? (oauth ? optionalEpochMs(entry.expires) : undefined),
    clientId: optionalString(meta.clientId),
    clientSecret: optionalString(meta.clientSecret),
  }
}

/** JSON file cache: `{ [baseURL]: { savedAt, models } }`. Read and write errors are ignored. */
export function fileSynapseModelsCache(
  file: string = path.join(Global.Path.state, "synapse-models.json"),
): SynapseModelsCache {
  const readAll = async (): Promise<Record<string, unknown>> => {
    try {
      const data: unknown = JSON.parse(await fs.readFile(file, "utf8"))
      return isRecord(data) ? data : {}
    } catch {
      return {}
    }
  }
  return {
    read: async (baseURL) => {
      const entry = (await readAll())[baseURL]
      if (!isRecord(entry) || !isRecord(entry.models)) return undefined
      const models: Record<string, SynapseModelEntry> = {}
      for (const [id, model] of Object.entries(entry.models)) if (isRecord(model)) models[id] = model
      return Object.keys(models).length > 0 ? models : undefined
    },
    write: async (baseURL, models) => {
      try {
        const all = await readAll()
        all[baseURL] = { savedAt: new Date().toISOString(), models }
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, JSON.stringify(all, null, 2))
      } catch {}
    },
  }
}

/** Wrap a log sink so each distinct (url, error) failure is logged once per process. */
export function createSynapseModelsFailureLogger(
  sink: (event: SynapseModelsLogEvent) => void,
  seen: Set<string>,
): (event: SynapseModelsLogEvent) => void {
  return (event) => {
    const key = `${event.url}\n${event.error}`
    if (seen.has(key)) return
    seen.add(key)
    sink(event)
  }
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

function synapseAllowed(cfg: Config): boolean {
  if (cfg.disabled_providers?.includes(SYNAPSE_PROVIDER_ID)) return false
  if (cfg.enabled_providers && !cfg.enabled_providers.includes(SYNAPSE_PROVIDER_ID)) return false
  return true
}

async function defaultResolveToken(): Promise<{ token?: string; expired: boolean }> {
  return { token: (await readStoredSynapseCredential())?.token, expired: false }
}

/** Where the model list is fetched from, for a config with an allowed `synapse` provider. */
export interface SynapseModelsTarget {
  baseURL: string
  headers: Record<string, string>
  apiKey?: string
}

export function synapseModelsTarget(cfg: Config, defaultBaseURL: string): SynapseModelsTarget | undefined {
  const provider = cfg.provider?.[SYNAPSE_PROVIDER_ID]
  if (!provider || !synapseAllowed(cfg)) return undefined
  const options = provider.options ?? {}
  return {
    baseURL: typeof options.baseURL === "string" && options.baseURL ? options.baseURL : defaultBaseURL,
    headers: stringHeaders(options.headers),
    apiKey: typeof options.apiKey === "string" && options.apiKey ? options.apiKey : undefined,
  }
}

async function fetchLiveModels(input: {
  target: SynapseModelsTarget
  token?: string
  fetch?: SynapseModelsFetch
  timeoutMs?: number
  userAgent?: string
}): Promise<Record<string, SynapseModelEntry>> {
  const headers = new Headers(input.target.headers)
  headers.set("accept", "application/json")
  if (input.userAgent) headers.set("user-agent", input.userAgent)
  // Same credential headers the chat path sends. With no token (the delegate box)
  // the request still goes out, and the front proxy injects the credential.
  if (input.token) {
    headers.set("authorization", `Bearer ${input.token}`)
    headers.set("x-api-key", input.token)
  }
  const response = await (input.fetch ?? fetch)(synapseModelsUrl(input.target.baseURL), {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(input.timeoutMs ?? SYNAPSE_MODELS_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const live = parseSynapseModelList(await response.json())
  if (Object.keys(live).length === 0) throw new Error("gateway returned no chat models")
  return live
}

/**
 * Best effort: fetch the live list with a freshly refreshed token and store it as the
 * last good list for the next startup. Never throws; returns whether it was written.
 */
export async function updateSynapseModelsCache(input: {
  target: SynapseModelsTarget
  token: string
  fetch?: SynapseModelsFetch
  cache?: SynapseModelsCache
  userAgent?: string
}): Promise<boolean> {
  try {
    const live = await fetchLiveModels(input)
    await (input.cache ?? fileSynapseModelsCache()).write(input.target.baseURL, live)
    return true
  } catch {
    return false
  }
}

/**
 * Replace `cfg.provider.synapse.models` with the gateway's live list plus `auto`.
 * With an expired stored token no request is made and the cached last good list is
 * used, else the configured models. On a failed fetch the same fallback applies and
 * the failure is logged. Never throws, and waits at most `timeoutMs` for the gateway.
 */
export async function loadSynapseModels(cfg: Config, deps: SynapseModelsDeps): Promise<SynapseModelsResult> {
  const target = synapseModelsTarget(cfg, deps.defaultBaseURL)
  const provider = cfg.provider?.[SYNAPSE_PROVIDER_ID]
  if (!target || !provider) return "skipped"

  const url = synapseModelsUrl(target.baseURL)
  const configured = provider.models ?? {}
  const auto = configured[SYNAPSE_AUTO_MODEL] ?? defaultAutoModel()
  const cache = deps.cache ?? fileSynapseModelsCache()
  const useFallback = async (): Promise<SynapseModelsResult> => {
    const cached = await cache.read(target.baseURL)
    provider.models = { ...(cached ?? configured), [SYNAPSE_AUTO_MODEL]: auto }
    return cached ? "cache" : "fallback"
  }

  let token: string | undefined
  try {
    const stored = await (deps.resolveToken ?? defaultResolveToken)()
    if (stored.expired) return await useFallback()
    token = stored.token ?? target.apiKey
    const live = await fetchLiveModels({
      target,
      token,
      fetch: deps.fetch,
      timeoutMs: deps.timeoutMs,
      userAgent: deps.userAgent,
    })
    provider.models = { ...live, [SYNAPSE_AUTO_MODEL]: auto }
    await cache.write(target.baseURL, live)
    return "live"
  } catch (error) {
    deps.log?.({ reason: "synapse-models-fetch-failed", url, error: errorText(error, token) })
    return await useFallback()
  }
}
