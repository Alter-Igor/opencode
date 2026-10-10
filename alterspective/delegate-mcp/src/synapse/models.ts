// #71: the models registered in Synapse, read on the HOST when the box starts. The box offers only
// these (profile.ts writes them as the `synapse` provider's models), so OpenCode in the box never
// fetches a model list itself (OPENCODE_DISABLE_MODELS_FETCH=1).
//
// The credential is the owner's delegated Synapse token the bridge already keeps for front
// (<home>/front/synapse-auth.conf, auth-conf.ts). It is sent to Synapse's read-only GET /v1/models
// only, the same route front allows the box (front-routes.ts). The token is never returned, logged
// or put in a reason.
//
// `auto` is Synapse's routing alias: Synapse does not list it, so it is always added, first.
// Entries Synapse marks as not chat-capable (embed, rerank or image only) are left out: an
// OpenCode session cannot use them. So are entries marked capabilities.tools false (#80,
// Synapse#1813): OpenCode always sends tools, so they would always fail. Absent or true keeps the
// entry. contextWindow / maxOutput become the model's limit.
//
// Any failure (no token yet, HTTP error, bad body, timeout) gives `auto` only and a reason: the box
// still starts, with Synapse's own routing. The owner's static model list is never a fallback (it
// goes stale). The list is read again at the next box start.
import { readFile } from "node:fs/promises"
import { SYNAPSE_HOST, authConfPath, isAuthConf } from "./auth-conf.ts"

export const SYNAPSE_MODELS_URL = `https://${SYNAPSE_HOST}/v1/models`
/** The bridge's own deadline for the call (AILES-059: never rely on a caller's signal). */
export const MODELS_TIMEOUT_MS = 4000
/** Synapse's routing alias and the box's default model (#71). */
export const AUTO_MODEL = "auto"
/** What the box offers when the list cannot be read: Synapse's own routing. */
export const FALLBACK_MODELS = [AUTO_MODEL] as const
/** A model id within MODEL_RE's model part (workspaces-state.ts): slash-separated segments, none starting with a dot. */
const MODEL_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*(\/[A-Za-z0-9][A-Za-z0-9._:@-]*)*$/
export const isModelId = (id: string) => id.length <= 128 && MODEL_ID_SHAPE.test(id)
const MAX_MODELS = 300
/** The most of Synapse's answer the bridge reads (review cycle 1). */
export const MAX_BODY_BYTES = 1024 * 1024
const BEARER_RE = /set \$synapse_auth "Bearer ([A-Za-z0-9._-]+)";/

export type ModelLimit = { context: number; output: number }
/** D4 (Synapse contract, stage 1): per-role benchmark fit, 0..1, published per model entry as
 *  `capabilities.suitability`. The role vocabulary is Synapse's: the bridge discovers the keys it
 *  finds and hardcodes none. Absent or malformed: the model has no fit data (fail open). */
export type Suitability = Record<string, number>

export type RegisteredModels =
  | { models: string[]; limits: Record<string, ModelLimit>; suitability?: Record<string, Suitability>; source: "synapse" }
  | { models: string[]; limits: Record<string, ModelLimit>; suitability?: Record<string, Suitability>; source: "fallback"; reason: string }

export type ModelsDeps = { frontDir: string; fetch: typeof fetch; timeoutMs?: number }

type Entry = { id: string; chat: boolean; limit?: ModelLimit; suitability?: Suitability }

const fallback = (reason: string): RegisteredModels => ({ models: [...FALLBACK_MODELS], limits: {}, source: "fallback", reason })

/** Never throws: a box start must not fail because the list cannot be read. */
export async function registeredModels(deps: ModelsDeps): Promise<RegisteredModels> {
  const token = await hostToken(deps.frontDir)
  if (!token) return fallback('no host-held Synapse token (run oc_login {server:"synapse"})')
  const timeoutMs = deps.timeoutMs ?? MODELS_TIMEOUT_MS
  const reply = await fetchWithin(deps.fetch, token, timeoutMs)
  if (reply === "timeout") return fallback(`Synapse did not answer within ${timeoutMs} ms`)
  if (reply === "unreachable") return fallback("Synapse could not be reached")
  if (reply === "too_large") return fallback(`Synapse's model list was larger than ${MAX_BODY_BYTES} bytes`)
  if (reply.status !== 200) return fallback(`Synapse answered HTTP ${reply.status}`)
  const entries = parseEntries(reply.text)
  if (!entries) return fallback("Synapse's model list was not readable")
  const usable = entries.filter((entry) => entry.chat && isModelId(entry.id) && entry.id !== AUTO_MODEL)
  const ids = [...new Set(usable.map((entry) => entry.id))].sort().slice(0, MAX_MODELS - 1)
  if (!ids.length && !entries.some((entry) => entry.id === AUTO_MODEL)) return fallback("Synapse listed no usable model ids")
  const limits: Record<string, ModelLimit> = {}
  for (const entry of usable) if (entry.limit && ids.includes(entry.id)) limits[entry.id] = entry.limit
  const suitability: Record<string, Suitability> = {}
  for (const entry of usable) if (entry.suitability && ids.includes(entry.id)) suitability[entry.id] = entry.suitability
  return { models: [AUTO_MODEL, ...ids], limits, ...(Object.keys(suitability).length > 0 ? { suitability } : {}), source: "synapse" }
}

type Reply = { status: number; text: string } | "timeout" | "unreachable" | "too_large"

/**
 * The call AND its body, under one deadline (review cycle 1, HIGH: a 200 with a stalled body must
 * not hold a box start, which runs inside the lease and the start lock). On the deadline the
 * request is aborted and the body stream cancelled, whether or not `fetch` honours the signal.
 */
async function fetchWithin(fetchFn: typeof fetch, token: string, timeoutMs: number): Promise<Reply> {
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      void reader?.cancel().catch(() => undefined)
      resolve("timeout")
    }, timeoutMs)
  })
  const call = async (): Promise<Reply> => {
    const res = await fetchFn(SYNAPSE_MODELS_URL, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: controller.signal })
    if (res.status !== 200 || !res.body) {
      void res.body?.cancel().catch(() => undefined)
      return { status: res.status, text: "" }
    }
    reader = res.body.getReader()
    return readCapped(reader, res.status)
  }
  try {
    return await Promise.race([call().catch((): Reply => "unreachable"), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** The body as text, or "too_large" past MAX_BODY_BYTES (the stream is cancelled, not read to the end). */
async function readCapped(reader: ReadableStreamDefaultReader<Uint8Array>, status: number): Promise<Reply> {
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined)
      return "too_large"
    }
    chunks.push(value)
  }
  return { status, text: new TextDecoder().decode(Buffer.concat(chunks)) }
}

/** The bearer token in front's include, or undefined (missing, malformed or empty include). */
async function hostToken(frontDir: string): Promise<string | undefined> {
  const text = await readFile(authConfPath(frontDir), "utf8").catch(() => undefined)
  if (text === undefined || !isAuthConf(text)) return undefined
  return BEARER_RE.exec(text)?.[1]
}

/**
 * capabilities.suitability: string keys, 0..1 numbers only. Anything malformed is dropped
 * (a hint must never break a read). Empty after filtering: undefined.
 */
function parseSuitability(value: unknown): Suitability | undefined {
  if (!isRecord(value)) return undefined
  const out: Suitability = {}
  for (const [role, score] of Object.entries(value)) {
    if (typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1 && role.length > 0 && role.length <= 64) out[role] = score
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** OpenAI's list shape, { data: [{ id, ... }] }, with Synapse's catalogue fields. Anything else is undefined. */
function parseEntries(text: string): Entry[] | undefined {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  const data = isRecord(body) ? body.data : undefined
  if (!Array.isArray(data)) return undefined
  return data.flatMap((item: unknown): Entry[] => {
    if (!isRecord(item) || typeof item.id !== "string") return []
    const limit = positiveInt(item.contextWindow) && positiveInt(item.maxOutput) ? { context: item.contextWindow, output: item.maxOutput } : undefined
    const suitability = isRecord(item.capabilities) ? parseSuitability(item.capabilities.suitability) : undefined
    return [{ id: item.id, chat: chatCapable(item.capabilities) && toolCapable(item.capabilities), ...(limit ? { limit } : {}), ...(suitability ? { suitability } : {}) }]
  })
}

/** Synapse's capabilities.ops: an entry that declares ops without "chat" is not a chat model. No ops declared: kept. */
function chatCapable(capabilities: unknown): boolean {
  const ops = isRecord(capabilities) ? capabilities.ops : undefined
  return !Array.isArray(ops) || ops.length === 0 || ops.includes("chat")
}

/** #80: capabilities.tools false means the model cannot take tool calls. Absent or true: kept. */
function toolCapable(capabilities: unknown): boolean {
  return !isRecord(capabilities) || capabilities.tools !== false
}

const positiveInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
