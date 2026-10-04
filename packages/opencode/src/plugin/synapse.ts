import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import { createServer } from "http"
import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"
import open from "open"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { INJECTED_LEARNINGS_LIMIT, learningStorePaths, sessionObserver, sanitizeJsonSchemaForOpenAI } from "./observer"
import { EscalationTracker, declaredTier, classifyFailure, malformedToolCallFromEvent } from "./synapse-escalation"
import {
  PinnedFallbackMemory,
  SYNAPSE_AUTO_ROUTE,
  classifyModelUnusable,
  isEventStream,
  isPinnedModel,
  mcpToolErrorText,
  pinnedFallbackEnabled,
  pinnedFallbackNotice,
  pinnedModelFallback,
  peekSseError,
  withAutoModel,
  type PinnedFallbackEvent,
  type StreamError,
} from "./synapse-fallback"
import {
  createSynapseModelsFailureLogger,
  loadSynapseModels,
  readStoredSynapseCredential,
  synapseModelsTarget,
  updateSynapseModelsCache,
  type SynapseModelsTarget,
  type SynapseStoredCredential,
} from "./synapse-models"

export const KEYSTONE_ISSUER = "https://identity.alterspective.com.au"
export const KEYSTONE_REGISTER = `${KEYSTONE_ISSUER}/api/oauth/register`
export const KEYSTONE_AUTHORIZE = `${KEYSTONE_ISSUER}/api/oauth/authorize`
export const KEYSTONE_TOKEN = `${KEYSTONE_ISSUER}/api/oidc/token`
export const SYNAPSE_DEFAULT_INFERENCE_URL = "https://synapse2-api.alterspective.com.au/v1"
export const SYNAPSE_RESOURCE = "https://synapse-mcp.alterspective.com.au/mcp"
/** #80: the MCP bridge path's fallback model: Synapse's own routing, still local-only. */
export const SYNAPSE_MCP_FALLBACK_MODEL = SYNAPSE_AUTO_ROUTE
// /v1 inference and /mcp both admit a token minted for the `synapse` app audience
// (ADR-0076 pass-through). A resource-URI audience is rejected by /v1, which is why
// the fork previously fell back to the MCP bridge (which cannot carry tool schemas).
export const SYNAPSE_AUDIENCE = "synapse"
export const OAUTH_SCOPES = "mcp:gpaas"
/** The registered Keystone downstream app that brokers Synapse access for the fork. */
export const HANDOFF_APP_ID = "opencode"
export const KEYSTONE_LOGIN = `${KEYSTONE_ISSUER}/api/auth/login`
/** The two credentials the delegated flow needs, resolved from the environment. */
export const BROKER_KEY_ENV = "OPENCODE_KEYSTONE_BROKER_KEY"
export const CLIENT_SECRET_ENV = "OPENCODE_KEYSTONE_CLIENT_SECRET"
export const OAUTH_PORT = 1459
export const OAUTH_REDIRECT_PATH = "/auth/callback"
export const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000

export interface SynapseServingTelemetry {
  model: string
  provider?: string
  costUsd?: string
  latencyMs?: string
  timestamp: number
}

let latestSynapseServing: SynapseServingTelemetry | undefined

// AIESC-001: observer-owned escalation state (session-keyed; directory fallback).
const escalations = new EscalationTracker()
const countedMalformedParts = new Set<string>()

export function getLatestSynapseServing(): SynapseServingTelemetry | undefined {
  return latestSynapseServing
}

export function setLatestSynapseServing(telemetry: SynapseServingTelemetry | undefined): void {
  latestSynapseServing = telemetry
}

export interface PkceCodes {
  verifier: string
  challenge: string
}

export function base64UrlEncode(buffer: Uint8Array): string {
  const base64 = Buffer.from(buffer).toString("base64")
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function generatePKCE(): Promise<PkceCodes> {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  const verifier = base64UrlEncode(array)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  const challenge = base64UrlEncode(new Uint8Array(digest))
  return { verifier, challenge }
}

export function generateState(): string {
  const array = new Uint8Array(24)
  crypto.getRandomValues(array)
  return base64UrlEncode(array)
}

export function redirectUri(port = OAUTH_PORT): string {
  // Explicit loopback IPv4, not "localhost": the callback server binds
  // 127.0.0.1, but on Windows "localhost" resolves to ::1 (IPv6) first, so the
  // browser's redirect landed on a closed port (ERR_CONNECTION_REFUSED).
  // Both loopback hosts are registered on the Keystone app, so either matches.
  return `http://127.0.0.1:${port}${OAUTH_REDIRECT_PATH}`
}

export function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".")
    if (parts.length < 2) return null
    const payload = Buffer.from(parts[1], "base64url").toString("utf8")
    return JSON.parse(payload) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * True when a Keystone JWT was minted for the `synapse` app audience, which the
 * REST inference plane admits (ADR-0076 pass-through). A token minted for the MCP
 * resource URI is only good for the MCP facade, so it must take the bridge path -
 * where no tool schemas exist and models can only guess text tool calls.
 */
export function audienceIsSynapse(token: string | undefined): boolean {
  if (!token || !token.startsWith("eyJ")) return false
  const aud = parseJwtPayload(token)?.aud
  return aud === "synapse" || (Array.isArray(aud) && aud.includes("synapse"))
}

export function accessTokenIsExpiring(token: string | undefined, skewMs = ACCESS_TOKEN_REFRESH_SKEW_MS): boolean {
  if (!token) return false
  const payload = parseJwtPayload(token)
  if (!payload || typeof payload.exp !== "number") return false
  const expMs = payload.exp * 1000
  const effectiveSkew = Math.max(0, skewMs)
  return expMs <= Date.now() + effectiveSkew
}

export async function registerKeystoneClient(
  redirect: string,
  fetcher: typeof fetch = fetch,
  registerUrl = KEYSTONE_REGISTER,
): Promise<{ clientId: string }> {
  const loopbackHosts = ["127.0.0.1", "localhost"]
  const url = new URL(redirect)
  const redirectUris = loopbackHosts.map((host) => {
    const next = new URL(redirect)
    next.hostname = host
    return next.toString()
  })

  const response = await fetcher(registerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "OpenCode Synapse Auth",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: OAUTH_SCOPES,
    }),
  })
  const body = (await response.json().catch(() => ({}))) as { client_id?: string; error?: string }
  if (!response.ok || !body.client_id) {
    throw new Error(`Keystone client registration failed (${response.status})`)
  }
  return { clientId: body.client_id }
}

export function buildAuthorizeUrl(
  input: {
    clientId: string
    redirectUri: string
    pkce: PkceCodes
    state: string
    authorizeUrl?: string
    scope?: string
    audience?: string
    resource?: string
  },
): string {
  const endpoint = input.authorizeUrl || KEYSTONE_AUTHORIZE
  const targetAudience = input.audience || SYNAPSE_AUDIENCE
  const targetScope = input.scope || OAUTH_SCOPES
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    audience: targetAudience,
    scope: targetScope,
    code_challenge: input.pkce.challenge,
    code_challenge_method: "S256",
    state: input.state,
  })
  return `${endpoint}?${params.toString()}`
}

/**
 * Keystone first-party handoff login. Unlike the OIDC authorize flow this yields
 * a short-lived HS256 handoff token that can be exchanged (RFC 8693) for a token
 * minted for the `synapse` app audience - which the REST inference plane admits.
 */
export function buildHandoffLoginUrl(input: {
  redirectUri: string
  nonce: string
  app?: string
  returnTo?: string
  loginUrl?: string
}): string {
  const params = new URLSearchParams({
    app: input.app || HANDOFF_APP_ID,
    redirect_uri: input.redirectUri,
    nonce: input.nonce,
    returnTo: input.returnTo || "/",
  })
  return `${input.loginUrl || KEYSTONE_LOGIN}?${params.toString()}`
}

/**
 * Exchange a Keystone handoff token for a token minted for the target audience
 * (default `synapse`). The caller authenticates as its registered app with a
 * service credential holding `credentials:broker`; Keystone stamps the app as
 * `act.sub`, which is what gives per-app attribution on the gateway.
 */
export async function exchangeHandoffForSynapseToken(
  input: {
    handoff: string
    brokerKey: string
    tokenUrl?: string
    audience?: string
    offline?: boolean
  },
  fetcher: typeof fetch = fetch,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    subject_token: input.handoff,
    audience: input.audience || SYNAPSE_AUDIENCE,
  })
  if (input.offline) body.set("scope", "offline_access")
  const response = await fetcher(input.tokenUrl || KEYSTONE_TOKEN, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Bearer ${input.brokerKey}`,
      "User-Agent": `opencode/${InstallationVersion}`,
    },
    body,
  })
  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
  }
  if (!response.ok || !json.access_token) {
    throw new Error(`Keystone token exchange failed (${response.status}): ${json.error || "unknown"}`)
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in ?? 3600,
  }
}

export async function exchangeCodeForTokens(
  input: {
    clientId: string
    code: string
    redirectUri: string
    verifier: string
    tokenUrl?: string
    audience?: string
    resource?: string
  },
  fetcher: typeof fetch = fetch,
): Promise<{
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}> {
  const endpoint = input.tokenUrl || KEYSTONE_TOKEN
  const targetAudience = input.audience || SYNAPSE_AUDIENCE
  const response = await fetcher(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": `opencode/${InstallationVersion}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
      audience: targetAudience,
    }),
  })
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    error?: string
  }
  if (!response.ok || !body.access_token) {
    throw new Error(`Keystone token exchange failed (${response.status}): ${body.error || "unknown"}`)
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_in: body.expires_in ?? 3600,
    scope: body.scope,
  }
}

/** A Keystone refresh call gives up after this, so it never holds the refresh lock for long (#75). */
export const KEYSTONE_REFRESH_TIMEOUT_MS = 30_000

export async function refreshKeystoneToken(
  input: {
    clientId: string
    refreshToken: string
    clientSecret?: string
    tokenUrl?: string
    audience?: string
    resource?: string
  },
  fetcher: typeof fetch = fetch,
): Promise<{
  access_token: string
  refresh_token?: string
  expires_in?: number
}> {
  const endpoint = input.tokenUrl || KEYSTONE_TOKEN
  const targetAudience = input.audience || SYNAPSE_AUDIENCE
  const response = await fetcher(endpoint, {
    method: "POST",
    redirect: "error",
    // #75: the refresh runs under a lock other OpenCode processes wait on; a hung call must end.
    signal: AbortSignal.timeout(KEYSTONE_REFRESH_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": `opencode/${InstallationVersion}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      audience: targetAudience,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    }),
  })
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!response.ok || !body.access_token) {
    throw new Error(`Keystone token refresh failed (${response.status})`)
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_in: body.expires_in,
  }
}

// vLLM-based on-prem backends reject any system message that is not at index 0
// ("System message must be at the beginning."). opencode emits the provider header
// and plugin system blocks as separate leading system messages — collapse every
// system/developer message into exactly one message at the front.
export function normalizeSystemMessages(
  messages: Array<{ role?: unknown; content?: unknown }>,
): Array<{ role?: unknown; content?: unknown }> {
  const systemTexts: string[] = []
  const rest: Array<{ role?: unknown; content?: unknown }> = []
  let systemTemplate: { role?: unknown; content?: unknown } | undefined

  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      systemTemplate ??= m
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((c: any) => (typeof c === "string" ? c : c?.text || "")).join("\n")
            : String(m.content ?? "")
      if (text.trim()) systemTexts.push(text)
    } else {
      rest.push(m)
    }
  }

  if (systemTexts.length === 0) return messages
  if (systemTexts.length === 1 && messages[0] === systemTemplate) return messages
  return [{ ...systemTemplate, role: "system", content: systemTexts.join("\n\n") }, ...rest]
}

/** Collapse the system blocks, in order, into a single entry (mutates `system`). */
export function foldSystemBlocks(system: string[]): void {
  const joined = system.filter((block) => block.trim()).join("\n\n")
  system.length = 0
  if (joined) system.push(joined)
}

export function sanitizeMessagesForSynapse(
  rawMessages: Array<{ role?: string; content?: any }>,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  let combinedSystemPrompt = ""
  const conversation: Array<{ role: "user" | "assistant"; content: string }> = []

  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i]
    const role = m.role || "user"
    const text = (
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((c: any) => (typeof c === "string" ? c : c.text || JSON.stringify(c)))
              .join("\n")
          : String(m.content ?? "")
    ).trim()

    if (role === "system" || role === "developer") {
      if (conversation.length === 0) {
        combinedSystemPrompt = combinedSystemPrompt ? combinedSystemPrompt + "\n\n" + text : text
      } else {
        conversation.push({ role: "user", content: `[System context: ${text || " "}]` })
      }
    } else if (role === "tool") {
      const toolName = (m as any).name || (m as any).tool || "tool"
      conversation.push({ role: "user", content: `[Tool Result for ${toolName}]:\n${text || "(no output)"}` })
    } else {
      const validRole = role === "assistant" ? "assistant" : "user"
      conversation.push({ role: validRole, content: text || " " })
    }
  }

  const result: Array<{ role: "system" | "user" | "assistant"; content: string }> = []
  if (combinedSystemPrompt) {
    result.push({ role: "system", content: combinedSystemPrompt })
  }
  result.push(...conversation)

  if (!result.some((m) => m.role === "user")) {
    result.push({ role: "user", content: " " })
  }

  return result
}

export interface ParsedToolCall {
  index: number
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export function normalizeToolName(name: string): string {
  let clean = String(name).trim().replace(/^(mcp__|tools\/|functions\.)/, "")

  // Map RAG tools: e.g. rag_ask -> alterspective-rag_rag_ask
  if (clean.startsWith("rag_") || clean.startsWith("rag-")) {
    return `alterspective-rag_${clean.replace(/-/g, "_")}`
  }
  if (clean === "rag" || clean === "ask_rag") {
    return "alterspective-rag_rag_ask"
  }
  if (clean === "search_rag") {
    return "alterspective-rag_rag_search"
  }

  // Map Playwright / browser tools: e.g. browser_click -> playwright_browser_click
  if (clean.startsWith("browser_") || clean.startsWith("browser-") || clean.startsWith("playwright_")) {
    const suffix = clean.replace(/^(playwright_|browser_)/, "")
    return `playwright_browser_${suffix.replace(/-/g, "_")}`
  }

  // Map Keystone tools
  if (clean === "search_tools" || clean === "searchTools" || clean === "search-tools") {
    return "keystone-dynamic_search-tools"
  }
  if (clean === "get_tool_schema" || clean === "getToolSchema" || clean === "get-tool-schema") {
    return "keystone-dynamic_get-tool-schema"
  }
  if (clean === "execute_tool" || clean === "executeTool" || clean === "execute-tool") {
    return "keystone-dynamic_execute-tool"
  }

  // Map common aliases
  if (clean === "read_file" || clean === "readFile" || clean === "cat") return "read"
  if (clean === "write_file" || clean === "writeFile") return "write"
  if (clean === "edit_file" || clean === "editFile") return "edit"
  if (clean === "find_files" || clean === "find") return "glob"
  if (clean === "search_text" || clean === "search") return "grep"

  return clean
}

export function extractToolCallsFromModelOutput(text: string): {
  toolCalls: ParsedToolCall[]
  cleanText: string
} {
  const toolCalls: ParsedToolCall[] = []
  let cleanText = text
  let idx = 0

  const pushCall = (item: any) => {
    if (!item || typeof item !== "object") return
    const rawName = item.name || item.tool || item.function
    if (!rawName) return
    const name = normalizeToolName(rawName)
    const args = item.arguments || item.parameters || item.args || {}
    toolCalls.push({
      index: idx++,
      id: `call_${Date.now()}_${idx}`,
      type: "function",
      function: {
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    })
  }

  // 1. XML-style <tool_call> tags
  const consumed: Array<[number, number]> = []
  const xmlRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi
  let match: RegExpExecArray | null
  while ((match = xmlRegex.exec(text)) !== null) {
    const before = toolCalls.length
    try {
      const parsed = JSON.parse(match[1].trim())
      if (Array.isArray(parsed)) {
        parsed.forEach(pushCall)
      } else {
        pushCall(parsed)
      }
    } catch {}
    // Only claim the range when it actually parsed. A block with junk inside
    // the tags (e.g. stray closing tags before the real close) must stay
    // unconsumed so the tolerant brace-matching scanner (pattern 4) can
    // recover the embedded JSON payload.
    if (toolCalls.length > before) consumed.push([match.index, match.index + match[0].length])
  }

  // 2. Markdown fenced code blocks: ```tool_call or ```json with {"name": ...}
  const fenceRegex = /```(?:tool_call|tool|json)?\s*\n?(\[\s*\{[\s\S]*?\}\s*\]|\{\s*"name"[\s\S]*?\})\s*\n?```/gi
  while ((match = fenceRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim())
      if (Array.isArray(parsed)) {
        parsed.forEach(pushCall)
      } else {
        pushCall(parsed)
      }
    } catch {}
  }

  // 3. Cline/Kimi-style function blocks - on-prem models drift to this
  // format when mimicking their training data. Tag literals are built by
  // concatenation so this source file stays free of raw marker sequences.
  const fnOpen = "<" + "function="
  const fnClose = "<" + "/function" + ">"
  const pOpen = "<" + "parameter="
  const pClose = "<" + "/parameter" + ">"
  const fnScan = new RegExp(fnOpen + "([^\\s>]+)>([\\s\\S]*?)" + fnClose, "gi")
  let fnMatch: RegExpExecArray | null
  while ((fnMatch = fnScan.exec(text)) !== null) {
    const params: Record<string, string> = {}
    const pScan = new RegExp(pOpen + "([^\\s>]+)>([\\s\\S]*?)" + pClose, "gi")
    let pMatch: RegExpExecArray | null
    while ((pMatch = pScan.exec(fnMatch[2])) !== null) {
      params[pMatch[1]] = pMatch[2].trim()
    }
    pushCall({ name: fnMatch[1], arguments: params })
  }

  // 4. Tolerant fallback: a tool-call block whose tags are malformed -
  // mismatched close, a stray "<" before the payload, or an open tag missing
  // its ">". A string-aware, stack-based JSON scanner keeps braces inside JSON
  // strings from terminating the payload early; array payloads are supported.
  const callOpen = "<" + "tool_call"
  const findJsonEnd = (src: string, start: number): number => {
    const QUOTE = String.fromCharCode(34)
    const stack: string[] = []
    let inString = false
    let escaped = false
    for (let j = start; j < src.length; j++) {
      const ch = src[j]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === QUOTE) inString = false
        continue
      }
      if (ch === QUOTE) inString = true
      else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]")
      else if (ch === "}" || ch === "]") {
        if (stack.pop() !== ch) return -1
        if (stack.length === 0) return j
      }
    }
    return -1
  }
  let cursor = 0
  while ((cursor = text.toLowerCase().indexOf(callOpen, cursor)) !== -1) {
    // Require a delimiter after the tag name so <tool_calls / <tool_calling
    // prose does not false-match the relaxed open tag.
    const next = text[cursor + callOpen.length]
    if (next !== undefined && /[a-z0-9_]/i.test(next)) {
      cursor += callOpen.length
      continue
    }
    if (consumed.some(([a, b]) => cursor >= a && cursor < b)) {
      cursor += callOpen.length
      continue
    }
    const after = text.slice(cursor + callOpen.length)
    const offset = after.search(/[\[{]/)
    if (offset === -1) break
    const payloadStart = cursor + callOpen.length + offset
    const payloadEnd = findJsonEnd(text, payloadStart)
    if (payloadEnd === -1) {
      cursor = payloadStart + 1
      continue
    }
    try {
      const parsed = JSON.parse(text.slice(payloadStart, payloadEnd + 1))
      if (Array.isArray(parsed)) parsed.forEach(pushCall)
      else pushCall(parsed)
    } catch {}
    cursor = payloadEnd
  }

  if (toolCalls.length > 0) {
    const stripFn = new RegExp(fnOpen + "[^\\s>]+>([\\s\\S]*?)" + fnClose, "gi")
    cleanText = text
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
      .replace(/```(?:tool_call|tool|json)?\s*\n?(\[\s*\{[\s\S]*?\}\s*\]|\{\s*"name"[\s\S]*?\})\s*\n?```/gi, "")
      .replace(stripFn, "")
      .replace(new RegExp(callOpen + "[\\s\\S]*?(?:<\\/?[a-z_]+>[\\s]*)+", "gi"), "")
      .replace(/<\/?tool_call>/gi, "")
      .replace(/<\/?>/g, "")
      .trim()
  }

  return { toolCalls, cleanText }
}

// Pull the assistant content out of an MCP tools/call SSE payload (same shape
// the main bridge parse loop reads). Returns "" when there is no usable content.
export function extractMcpChatContent(rawText: string): string {
  for (const event of rawText.split(/\r?\n\r?\n/)) {
    const dataLines = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
    if (dataLines.length === 0) continue
    try {
      const data = JSON.parse(dataLines.join("\n"))
      const direct = data.result?.structuredContent?.content
      if (typeof direct === "string" && direct) return direct
      const text = data.result?.content?.[0]?.text
      if (typeof text === "string" && text) {
        try {
          const inner = JSON.parse(text)
          if (typeof inner?.content === "string" && inner.content) return inner.content
        } catch {
          return text
        }
      }
    } catch {}
  }
  return ""
}

// Distinct startup model-fetch failures already logged by this process.
const synapseModelsFailuresSeen = new Set<string>()

/** How long a chat request waits for a Keystone refresh before it goes ahead with the old token. */
export const SYNAPSE_CHAT_REFRESH_WAIT_MS = 15_000

interface SynapseCredentialState {
  /** Newest refreshed credential. */
  latest?: SynapseStoredCredential & { refreshToken: string; expiresAt: number }
  /** Every access and refresh token this process has replaced. A stored one in here is stale, not a new login. */
  replaced: Set<string>
  /** The one in-flight Keystone refresh grant. Never rejects; undefined when it failed. */
  refresh?: Promise<string | undefined>
  /** The save of `latest`. Never rejects. */
  save?: Promise<void>
  saveFailureLogged: boolean
}

// Process-wide, because every plugin instance shares the one stored `synapse`
// credential and a Keystone refresh token can be used only once: a reuse revokes the
// whole login. Inside a process the single-flight guard below holds; across processes
// (a TUI plus `opencode serve`, or two TUIs) the file lock does (#75).
const synapseCredentialState: SynapseCredentialState = { replaced: new Set(), saveFailureLogged: false }

/** Runs `fn` while holding the refresh lock. Injectable so tests can observe or replace it. */
export type SynapseRefreshLock = <T>(fn: () => Promise<T>) => Promise<T>

/** How long a refresh waits for another process's refresh before it gives up (the chat keeps its old token). */
export const SYNAPSE_REFRESH_LOCK_TIMEOUT_MS = 60_000

/** The lock key: one per credential file, shared by every OpenCode process on this machine. */
export function synapseRefreshLockKey(file: string = path.join(Global.Path.data, "auth.json")): string {
  return `synapse-refresh:${file}`
}

/** #75: the machine-wide lock around the refresh grant (a lock directory under the OpenCode state folder). */
export const synapseRefreshFileLock: SynapseRefreshLock = (fn) =>
  Flock.withLock(synapseRefreshLockKey(), fn, { timeoutMs: SYNAPSE_REFRESH_LOCK_TIMEOUT_MS })

/**
 * The credential to use: the newest refreshed one in memory, unless the stored one
 * is a new login. A stored credential whose access or refresh token this process has
 * already replaced is stale (its save is pending or failed, or OPENCODE_AUTH_CONTENT
 * pins it), so the in-memory one wins.
 */
function currentSynapseCredential(stored: SynapseStoredCredential): SynapseStoredCredential {
  const { latest, replaced } = synapseCredentialState
  if (!latest) return stored
  if (stored.token === latest.token || replaced.has(stored.token)) return latest
  if (stored.refreshToken && (stored.refreshToken === latest.refreshToken || replaced.has(stored.refreshToken))) {
    return latest
  }
  return stored
}

/**
 * The token for the startup `/models` fetch, and whether it is already expired.
 * Startup never refreshes: with an expired token the cached (or configured) list is
 * used, and the cache is brought up to date after the next chat refresh.
 */
export function synapseModelsToken(
  cred: SynapseStoredCredential | undefined,
  now: number = Date.now(),
): { token?: string; expired: boolean } {
  if (!cred) return { expired: false }
  const expired =
    (cred.expiresAt !== undefined && cred.expiresAt - now <= ACCESS_TOKEN_REFRESH_SKEW_MS) ||
    accessTokenIsExpiring(cred.token)
  return { token: cred.token, expired }
}

/** Resolve with `promise`, or with undefined once `ms` has passed. `promise` keeps running. */
async function waitAtMost<T>(promise: Promise<T | undefined>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const gaveUp = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([promise, gaveUp])
  } finally {
    clearTimeout(timer)
  }
}

interface SynapsePluginOptions {
  authorizeUrl?: string
  loginUrl?: string
  tokenUrl?: string
  registerUrl?: string
  inferenceUrl?: string
  audience?: string
  /** How long a chat request waits for a token refresh. Default SYNAPSE_CHAT_REFRESH_WAIT_MS. */
  refreshWaitMs?: number
  /** #75: the cross-process lock around a refresh. Default synapseRefreshFileLock. */
  refreshLock?: SynapseRefreshLock
  /** #80: resend a failed pinned-model request once with `auto`. Default: on unless OPENCODE_SYNAPSE_PINNED_FALLBACK=0. */
  pinnedFallback?: boolean
  /** #80: tell the person a pinned model fell back to `auto`. Default: a TUI toast when the client has one. */
  notify?: (message: string) => void
  /** #80: per-session memory of failed pinned models (process memory, ~10 min TTL). Injectable for tests. */
  fallbackMemory?: PinnedFallbackMemory
  /** #80 follow-up: bounds for peeking at a stream's first event. Default 64 KB and 15 s. */
  ssePeek?: { maxBytes?: number; timeoutMs?: number }
}

export async function SynapseAuthPlugin(input: PluginInput, options?: SynapsePluginOptions): Promise<Hooks> {
  const inferenceUrl = options?.inferenceUrl || process.env.SYNAPSE_BASE_URL || SYNAPSE_DEFAULT_INFERENCE_URL
  const audience = options?.audience || SYNAPSE_AUDIENCE
  const userAgent = `opencode/${InstallationVersion}`
  // Set by the auth loader per request: true when the credential is a Keystone
  // JWT (MCP bridge path, text tool-call protocol), false on the native REST path.
  let bridgeMode = false
  // Where this instance's model list comes from; set by the config hook.
  let modelsTarget: SynapseModelsTarget | undefined

  // #80: failed pinned models per session, so later steps skip them until the mark expires.
  const fallbackMemory = options?.fallbackMemory ?? new PinnedFallbackMemory()

  // #80: log the pinned-model fallback (no token, no message text) and tell the person.
  // Callers report once per session and model (fallbackMemory.shouldReport).
  function reportPinnedFallback(event: PinnedFallbackEvent): void {
    sessionObserver.logDiagnostic(
      { timestamp: new Date().toISOString(), type: "FALLBACK_TRIGGERED", details: { ...event } },
      input.directory,
    )
    const message = pinnedFallbackNotice(event)
    try {
      if (options?.notify) return options.notify(message)
      const toast = input.client?.tui?.showToast?.({ body: { title: "Synapse", message, variant: "warning" } })
      void Promise.resolve(toast).catch(() => undefined)
    } catch {}
  }

  async function saveSynapseCredential(cred: NonNullable<SynapseCredentialState["latest"]>): Promise<void> {
    try {
      await input.client.auth.set({
        path: { id: "synapse" },
        body: {
          type: "api",
          key: cred.token,
          metadata: {
            clientId: cred.clientId ?? "ai-office-cli",
            refreshToken: cred.refreshToken,
            expiresAt: String(cred.expiresAt),
          },
        },
      })
    } catch (error) {
      // The new token stays in memory for this process, so nothing reuses the spent
      // refresh token; only a restart would need a fresh login.
      if (synapseCredentialState.saveFailureLogged) return
      synapseCredentialState.saveFailureLogged = true
      sessionObserver.logDiagnostic(
        {
          timestamp: new Date().toISOString(),
          type: "AUTH_EVENT",
          details: { event: "synapse-token-save-failed", error: error instanceof Error ? error.name : "unknown" },
        },
        input.directory,
      )
    }
  }

  // One Keystone refresh at a time per process (refresh tokens are single-use), and one
  // at a time across processes through the file lock (#75). The grant is never aborted by
  // the chat's wait: its new credential is held in memory, the replaced tokens are
  // remembered, it is saved before the lock is released, and the model-list cache is
  // updated in the background.
  function refreshSynapseCredential(cred: {
    token: string
    clientId?: string
    refreshToken: string
    clientSecret?: string
  }): Promise<string | undefined> {
    if (synapseCredentialState.refresh) return synapseCredentialState.refresh
    const run = async (): Promise<string | undefined> => {
      try {
        return await (options?.refreshLock ?? synapseRefreshFileLock)(() => refreshLocked(cred))
      } catch {
        return undefined
      } finally {
        synapseCredentialState.refresh = undefined
      }
    }
    const pending = run()
    synapseCredentialState.refresh = pending
    return pending
  }

  // Call only while holding the refresh lock.
  async function refreshLocked(cred: {
    token: string
    clientId?: string
    refreshToken: string
    clientSecret?: string
  }): Promise<string | undefined> {
    const { replaced } = synapseCredentialState
    // #75: another process may have refreshed while this one waited for the lock. Its rotated
    // refresh token is now the only valid one: spending ours would make Keystone revoke the login.
    const stored = await readStoredSynapseCredential().catch(() => undefined)
    const newer =
      stored?.refreshToken && stored.refreshToken !== cred.refreshToken && !replaced.has(stored.refreshToken)
        ? { ...stored, refreshToken: stored.refreshToken }
        : undefined
    if (newer && !synapseModelsToken(newer).expired) {
      // Use it as it is. Marking ours as replaced makes the stored credential win from now on.
      replaced.add(cred.token)
      replaced.add(cred.refreshToken)
      return newer.token
    }
    const source = newer ?? cred
    const clientId = source.clientId || cred.clientId || "ai-office-cli"
    const clientSecret = source.clientSecret || cred.clientSecret
    const tokens = await refreshKeystoneToken({
      clientId,
      refreshToken: source.refreshToken,
      clientSecret: clientSecret || process.env[CLIENT_SECRET_ENV] || "",
      tokenUrl: options?.tokenUrl,
      audience,
    })
    const latest = {
      token: tokens.access_token,
      refreshToken: tokens.refresh_token || source.refreshToken,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      clientId,
      clientSecret,
    }
    for (const spent of [cred, source]) {
      replaced.add(spent.token)
      if (latest.refreshToken !== spent.refreshToken) replaced.add(spent.refreshToken)
    }
    synapseCredentialState.latest = latest
    synapseCredentialState.save = saveSynapseCredential(latest)
    // #75: saved before the lock is released, so the next process reads the rotated token.
    await synapseCredentialState.save
    if (modelsTarget) {
      void updateSynapseModelsCache({ target: modelsTarget, token: latest.token, userAgent })
    }
    return tokens.access_token
  }

  return {
    // Fork-only (#74): the live Synapse model list replaces a hand-typed one.
    // Core reads cfg.provider after this hook resolves (provider/provider.ts).
    config: async (cfg) => {
      modelsTarget = synapseModelsTarget(cfg, inferenceUrl)
      await loadSynapseModels(cfg, {
        defaultBaseURL: inferenceUrl,
        userAgent,
        resolveToken: async () => {
          const stored = await readStoredSynapseCredential()
          return synapseModelsToken(stored && currentSynapseCredential(stored))
        },
        log: createSynapseModelsFailureLogger((event) => {
          sessionObserver.logDiagnostic(
            { timestamp: new Date().toISOString(), type: "FALLBACK_TRIGGERED", details: { ...event } },
            input.directory,
          )
        }, synapseModelsFailuresSeen),
      })
    },
    auth: {
      provider: "synapse",
      loader: async (getAuth) => {
        const authData = await getAuth()
        if (!authData) {
          return {
            baseURL: inferenceUrl,
            headers: {
              "x-task-type": "code",
            },
          }
        }

        const resolvedKey = authData.type === "api" ? authData.key : authData.type === "oauth" ? authData.access : ""
        const isJwtToken = resolvedKey.startsWith("eyJ")
        bridgeMode = isJwtToken

        return {
          apiKey: isJwtToken ? "oauth-synapse-bearer" : resolvedKey,
          baseURL: inferenceUrl,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            // An earlier refresh may still be saving its rotated token.
            await synapseCredentialState.save
            let currentAuth = await getAuth()
            const storedToken =
              currentAuth.type === "api"
                ? currentAuth.key
                : currentAuth.type === "oauth"
                  ? currentAuth.access
                  : ""

            const meta = (currentAuth as any).metadata || {}
            // Prefer the newest refreshed credential held in memory over a stored one it replaced.
            const cred = currentSynapseCredential({
              token: storedToken,
              refreshToken: meta.refreshToken || (currentAuth.type === "oauth" ? currentAuth.refresh : undefined),
              expiresAt: Number(meta.expiresAt || (currentAuth.type === "oauth" ? currentAuth.expires : 0)) || undefined,
              clientId: meta.clientId,
              clientSecret: meta.clientSecret,
            })
            let activeToken = cred.token
            const refreshToken = cred.refreshToken
            const expires = cred.expiresAt ?? 0

            const isExpiring = !expires || expires - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS || accessTokenIsExpiring(activeToken)

            if (isExpiring && refreshToken) {
              // Only the waiting is bounded. The grant itself always runs to the end and
              // its new token is kept and saved, so a late reply is never thrown away.
              const refreshed = await waitAtMost(
                refreshSynapseCredential({ ...cred, refreshToken }),
                options?.refreshWaitMs ?? SYNAPSE_CHAT_REFRESH_WAIT_MS,
              )
              if (refreshed) activeToken = refreshed
              // Keep the chat path's guarantee: the rotated token is saved before use.
              await synapseCredentialState.save
            }

            // Parse request body for logging and tool sanitization
            let requestBodyJson: any = null
            let sanitizedBody = init?.body
            // AIESC-02: escalation is observer-owned; key by session when known.
            const sessionKey = new Headers(init?.headers as HeadersInit).get("x-opencode-session") || input.directory
            // #80: resend a failed pinned-model request once with `auto` (opt out: OPENCODE_SYNAPSE_PINNED_FALLBACK=0).
            const pinnedFallbackOn = options?.pinnedFallback ?? pinnedFallbackEnabled()
            if (typeof init?.body === "string") {
              try {
                requestBodyJson = JSON.parse(init.body)
                if (requestBodyJson.tools && Array.isArray(requestBodyJson.tools)) {
                  for (const t of requestBodyJson.tools) {
                    if (t.function?.parameters) {
                      t.function.parameters = sanitizeJsonSchemaForOpenAI(t.function.parameters)
                    }
                  }
                }
                if (Array.isArray(requestBodyJson.messages)) {
                  requestBodyJson.messages = normalizeSystemMessages(requestBodyJson.messages)
                }
                sanitizedBody = JSON.stringify(requestBodyJson)
                sessionObserver.logDiagnostic(
                  {
                    timestamp: new Date().toISOString(),
                    type: "INFERENCE_REQUEST",
                    details: {
                      model: requestBodyJson.model,
                      messagesCount: requestBodyJson.messages?.length,
                      toolsCount: requestBodyJson.tools?.length,
                      toolNames: requestBodyJson.tools?.map((x: any) => x.function?.name),
                    },
                  },
                  input.directory,
                )
              } catch {}
            }

            // If authenticating via Keystone JWT token, execute through Synapse MCP bridge
            const rawMessages = requestBodyJson?.messages || (requestBodyJson?.prompt ? [{ role: "user", content: requestBodyJson.prompt }] : [])
            // Route by audience. A token minted for the `synapse` app audience is
            // admitted by the REST plane, which carries native tool schemas. Only a
            // token minted for the MCP resource URI (older logins) falls back to the
            // MCP bridge - which cannot carry tool schemas, so models there can only
            // guess text tool calls.
            if (activeToken.startsWith("eyJ") && !audienceIsSynapse(activeToken) && rawMessages.length > 0) {
                // The bridge chat tool has no tier knob; evaluate the tracker so a
                // persistently failing bridge session still reaches the human gate (AIESC-03).
                escalations.resolveTier(sessionKey, "premium")
              try {
                const normalizedMessages = sanitizeMessagesForSynapse(rawMessages)

                const callMcp = async (args: Record<string, any>) => {
                  return await fetch("https://synapse-mcp.alterspective.com.au/mcp", {
                    method: "POST",
                    signal: init?.signal,
                    headers: {
                      "Content-Type": "application/json",
                      Accept: "application/json, text/event-stream",
                      Authorization: `Bearer ${activeToken}`,
                    },
                    body: JSON.stringify({
                      jsonrpc: "2.0",
                      id: Date.now(),
                      method: "tools/call",
                      params: {
                        name: "chat",
                        arguments: args,
                      },
                    }),
                  })
                }

                let chatArgs: Record<string, any> = {
                  messages: normalizedMessages,
                  ...(requestBodyJson?.model && requestBodyJson.model !== "auto"
                    ? { model: requestBodyJson.model }
                    : {}),
                  taskType: "code",
                  ...(typeof requestBodyJson?.max_tokens === "number"
                    ? { maxTokens: requestBodyJson.max_tokens }
                    : {}),
                }

                // #80: the fallback is Synapse's own routing (`auto`), kept local-only.
                const autoChatArgs = (): Record<string, any> => ({
                  messages: normalizedMessages,
                  model: SYNAPSE_MCP_FALLBACK_MODEL,
                  privacyTier: "local-only",
                  taskType: "code",
                  ...(typeof requestBodyJson?.max_tokens === "number"
                    ? { maxTokens: requestBodyJson.max_tokens }
                    : {}),
                })
                const mcpModel: unknown = requestBodyJson?.model
                const mcpPinned = isPinnedModel(mcpModel) && pinnedFallbackOn
                // Shown inline once per session and model, alongside the one toast.
                let fallbackApplied = false

                // A pinned model that failed in this session lately goes straight to `auto`.
                if (mcpPinned && fallbackMemory.isFailed(sessionKey, mcpModel)) chatArgs = autoChatArgs()

                let mcpRes = await callMcp(chatArgs)
                let rawText = mcpRes.ok ? await mcpRes.text() : ""

                // The same classifier as the REST path. Never for 401/403 or an `auto` request;
                // a 200 counts only when it carries a tool error, never for words in a reply.
                if (mcpPinned && chatArgs.model === mcpModel) {
                  const errorText = mcpRes.ok ? mcpToolErrorText(rawText) : await mcpRes.clone().text().catch(() => "")
                  const reason =
                    errorText === undefined ? undefined : classifyModelUnusable(mcpRes.ok ? 0 : mcpRes.status, errorText)
                  if (reason && !init?.signal?.aborted) {
                    chatArgs = autoChatArgs()
                    const fallbackRes = await callMcp(chatArgs)
                    const fallbackText = fallbackRes.ok ? await fallbackRes.text() : ""
                    fallbackMemory.markFailed(sessionKey, mcpModel)
                    if (fallbackMemory.shouldReport(sessionKey, mcpModel)) {
                      reportPinnedFallback({
                        originalModel: mcpModel,
                        reason,
                        status: mcpRes.status,
                        fallbackModel: SYNAPSE_MCP_FALLBACK_MODEL,
                        fallbackStatus: fallbackRes.status,
                        localOnly: true,
                      })
                      fallbackApplied = fallbackRes.ok
                    }
                    if (fallbackRes.ok) {
                      mcpRes = fallbackRes
                      rawText = fallbackText
                    }
                  }
                }

                if (mcpRes.ok) {
                  let parsedContent = ""
                  let servedModel = "synapse-auto"
                  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

                  // Extract all data: payloads cleanly from multiline MCP SSE stream
                  const sseChunks = rawText.split(/(?:^|\n)data:\s*/g).filter(Boolean)
                  for (const chunk of sseChunks) {
                    try {
                      const data = JSON.parse(chunk.trim())
                      if (data.isError || data.result?.isError || data.result?.structuredContent?.error || data.error) {
                        const errObj = data.result?.structuredContent?.error || data.error || data.result?.content?.[0]?.text
                        const errMsg = typeof errObj === "string" ? errObj : errObj?.message || JSON.stringify(errObj)
                        sessionObserver.logDiagnostic(
                          {
                            timestamp: new Date().toISOString(),
                            type: "INFERENCE_ERROR",
                            error: `Synapse Error: ${errMsg}`,
                            details: { error: errObj },
                          },
                          input.directory,
                        )
                        escalations.recordFailure(sessionKey, classifyFailure(mcpRes.status, errMsg))
                        return new Response(
                          JSON.stringify({ error: { message: errMsg, type: "invalid_request_error" } }),
                          {
                            status: 400,
                            headers: { "Content-Type": "application/json" },
                          },
                        )
                      }

                      if (data.result?.structuredContent?.content) {
                        parsedContent = data.result.structuredContent.content
                      } else if (data.result?.content?.[0]?.text) {
                        try {
                          const inner = JSON.parse(data.result.content[0].text)
                          if (inner.content) {
                            parsedContent = inner.content
                          } else if (!inner.error) {
                            parsedContent = data.result.content[0].text
                          }
                        } catch {
                          parsedContent = data.result.content[0].text
                        }
                      }
                      if (data.result?.structuredContent?.servedModel) {
                        servedModel = data.result.structuredContent.servedModel
                      }
                      if (data.result?.structuredContent?.usage) {
                        const u = data.result.structuredContent.usage
                        usage = {
                          prompt_tokens: u.promptTokens || 0,
                          completion_tokens: u.completionTokens || 0,
                          total_tokens: u.totalTokens || 0,
                        }
                      }
                    } catch {}
                  }

                  if (!parsedContent) {
                    try {
                      const data = JSON.parse(rawText)
                      if (data.result?.structuredContent?.content) {
                        parsedContent = data.result.structuredContent.content
                      } else if (data.result?.content?.[0]?.text) {
                        try {
                          const inner = JSON.parse(data.result.content[0].text)
                          if (inner.content) {
                            parsedContent = inner.content
                          } else if (!inner.error) {
                            parsedContent = data.result.content[0].text
                          }
                        } catch {
                          parsedContent = data.result.content[0].text
                        }
                      }
                    } catch {}
                  }

                  // Strip leading newline artifacts if model responded with \n\n
                  parsedContent = parsedContent.replace(/^\n+/, "")


                  if (fallbackApplied) {
                    parsedContent = `[Notice: the requested model was unavailable. Switched to Synapse auto (local-only).]\n\n${parsedContent}`
                  }

                  sessionObserver.logDiagnostic(
                    {
                      timestamp: new Date().toISOString(),
                      type: "INFERENCE_RESPONSE",
                      details: {
                        model: servedModel,
                        contentLength: parsedContent.length,
                        contentSnippet: parsedContent.slice(0, 200),
                        isStreaming: Boolean(requestBodyJson.stream),
                      },
                    },
                    input.directory,
                  )

                  latestSynapseServing = {
                    model: servedModel,
                    timestamp: Date.now(),
                  }

                  const extracted = extractToolCallsFromModelOutput(parsedContent)
                  let toolCalls = extracted.toolCalls
                  let cleanText = extracted.cleanText

                  // Drift repair (#20, plugin-local): the model attempted a text tool
                  // call that did not parse. Echo it back and re-ask ONCE for a clean
                  // call; adopt the retry only if it yields real tool calls.
                  const markupCount0 = (parsedContent.match(new RegExp("<" + "tool_call|<" + "function=", "gi")) || []).length
                  if (markupCount0 > 0 && toolCalls.length === 0 && !init?.signal?.aborted && Array.isArray(chatArgs.messages)) {
                    const repairMessages = [
                      ...chatArgs.messages,
                      { role: "assistant", content: parsedContent },
                      {
                        role: "user",
                        content:
                          "Your previous reply attempted a tool call as text and the payload was malformed. Call the tool again: output ONLY the tool-call block with valid JSON (escape quotes inside strings). No prose.",
                      },
                    ]
                    try {
                      const retryRes = await callMcp({ ...chatArgs, messages: repairMessages })
                      if (retryRes.ok) {
                        const retryContent = extractMcpChatContent(await retryRes.text())
                        if (retryContent) {
                          const retryExtracted = extractToolCallsFromModelOutput(retryContent)
                          if (retryExtracted.toolCalls.length > 0) {
                            parsedContent = retryContent
                            toolCalls = retryExtracted.toolCalls
                            cleanText = retryExtracted.cleanText
                            sessionObserver.logDiagnostic(
                              {
                                timestamp: new Date().toISOString(),
                                type: "ESCALATION",
                                details: { kind: "drift-repair", recovered: true, calls: retryExtracted.toolCalls.length },
                              },
                              input.directory,
                            )
                          }
                        }
                      }
                    } catch {}
                  }

                  const markupCount = (parsedContent.match(new RegExp("<" + "tool_call|<" + "function=", "gi")) || []).length
                  if (parsedContent.trim() && markupCount <= toolCalls.length && (toolCalls.length > 0 || cleanText.trim())) escalations.recordSuccess(sessionKey)
                  else if (!parsedContent.trim()) escalations.recordFailure(sessionKey, "empty-content")
                  else escalations.recordFailure(sessionKey, "malformed-output")

                  if (requestBodyJson.stream) {
                    const encoder = new TextEncoder()
                    const stream = new ReadableStream({
                      start(controller) {
                        // 1. Initial role chunk
                        const roleChunk = {
                          id: `chatcmpl-${Date.now()}`,
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: servedModel,
                          choices: [{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }],
                        }
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`))

                        // 2. Content chunks (stream words for responsive TUI)
                        if (cleanText) {
                          const words = cleanText.match(/\S+|\s+/g) || [cleanText]
                          for (const word of words) {
                            if (init?.signal?.aborted) return
                            const wordChunk = {
                              id: `chatcmpl-${Date.now()}`,
                              object: "chat.completion.chunk",
                              created: Math.floor(Date.now() / 1000),
                              model: servedModel,
                              choices: [{ index: 0, delta: { content: word }, logprobs: null, finish_reason: null }],
                            }
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(wordChunk)}\n\n`))
                          }
                        }

                        // 3. Emit tool_calls if any were requested by the model
                        if (toolCalls.length > 0) {
                          for (const tc of toolCalls) {
                            if (init?.signal?.aborted) return
                            const toolChunk = {
                              id: `chatcmpl-${Date.now()}`,
                              object: "chat.completion.chunk",
                              created: Math.floor(Date.now() / 1000),
                              model: servedModel,
                              choices: [
                                {
                                  index: 0,
                                  delta: {
                                    tool_calls: [tc],
                                  },
                                  logprobs: null,
                                  finish_reason: null,
                                },
                              ],
                            }
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolChunk)}\n\n`))
                          }
                        }

                        // 4. Final stop chunk with proper finish_reason
                        const stopChunk = {
                          id: `chatcmpl-${Date.now()}`,
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: servedModel,
                          choices: [
                            {
                              index: 0,
                              delta: {},
                              logprobs: null,
                              finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
                            },
                          ],
                          usage,
                        }
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`))
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                        controller.close()
                      },
                    })

                    return new Response(stream, {
                      status: 200,
                      headers: {
                        "Content-Type": "text/event-stream; charset=utf-8",
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                        "x-synapse-served-model": servedModel,
                      },
                    })
                  }

                  const resObj = {
                    id: `chatcmpl-${Date.now()}`,
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model: servedModel,
                    choices: [
                      {
                        index: 0,
                        message: {
                          role: "assistant",
                          content: cleanText || (toolCalls.length > 0 ? null : ""),
                          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                        },
                        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
                      },
                    ],
                    usage,
                  }

                  return new Response(JSON.stringify(resObj), {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      "x-synapse-served-model": servedModel,
                    },
                  })
                }
              } catch (err: any) {
                sessionObserver.logDiagnostic(
                  {
                    timestamp: new Date().toISOString(),
                    type: "INFERENCE_ERROR",
                    error: `Synapse MCP bridge error: ${err.message || String(err)}`,
                    details: { error: String(err) },
                  },
                  input.directory,
                )
              }
            }

            // Fallback to direct REST API with Authorization / x-api-key headers
            const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
            if (init?.headers) {
              const entries =
                init.headers instanceof Headers
                  ? init.headers.entries()
                  : Array.isArray(init.headers)
                    ? init.headers
                    : Object.entries(init.headers as Record<string, string | undefined>)
              for (const [key, value] of entries) {
                if (value !== undefined) headers.set(key, String(value))
              }
            }

            headers.set("authorization", `Bearer ${activeToken}`)
            headers.set("x-api-key", activeToken)
            headers.set("x-task-type", "code")
            headers.set("User-Agent", `opencode/${InstallationVersion}`)

            // AIESC-01/02: declared tier per model; observer-owned one-request bump.
            const baseTier = declaredTier(requestBodyJson?.model) ?? "balanced"
            const appliedTier = escalations.resolveTier(sessionKey, baseTier, {
              localOnly: headers.get("x-privacy-tier") === "local-only",
            })
            headers.set("x-quality-tier", appliedTier)
            if (appliedTier !== baseTier) {
              sessionObserver.logDiagnostic(
                {
                  timestamp: new Date().toISOString(),
                  type: "ESCALATION",
                  details: { from: baseTier, to: appliedTier, ...escalations.snapshot(sessionKey) },
                },
                input.directory,
              )
            }

            // #80: a pinned model that failed in this session lately goes straight to `auto`
            // (no failed attempt first) until its mark expires.
            const pinnedModel: unknown = requestBodyJson?.model
            let sentModel: unknown = pinnedModel
            if (pinnedFallbackOn && isPinnedModel(pinnedModel) && fallbackMemory.isFailed(sessionKey, pinnedModel)) {
              const autoBody = withAutoModel(sanitizedBody)
              if (autoBody) {
                sanitizedBody = autoBody
                sentModel = SYNAPSE_AUTO_ROUTE
              }
            }

            let response = await fetch(requestInput, { ...init, body: sanitizedBody, headers }).catch((err: unknown) => {
              escalations.recordFailure(sessionKey, "provider-error")
              throw err
            })
            // #80: a pinned model that cannot serve this request is resent ONCE with `auto`
            // (same body and headers, so local-only stays local-only).
            let pinnedFailure: { status: number; statusText: string; errorBody: string } | undefined
            // #80 follow-up: with stream:true the failure comes as the first event of an HTTP 200
            // stream. Peek at that event only (bounded); the stream is handed on byte for byte.
            let streamError: StreamError | undefined
            if (response.ok && sentModel === pinnedModel && pinnedFallbackOn && isPinnedModel(pinnedModel) && isEventStream(response)) {
              const peek = await peekSseError(response, { ...options?.ssePeek, signal: init?.signal })
              response = peek.response
              streamError = peek.error
            }
            if ((!response.ok || streamError) && sentModel === pinnedModel) {
              const failed = response
              const fallback = await pinnedModelFallback({
                model: pinnedModel,
                body: sanitizedBody,
                headers,
                response,
                enabled: pinnedFallbackOn,
                signal: init?.signal,
                resend: (body) => fetch(requestInput, { ...init, body, headers }),
                streamError,
              })
              if (fallback.event) {
                fallbackMemory.markFailed(sessionKey, fallback.event.originalModel)
                if (fallbackMemory.shouldReport(sessionKey, fallback.event.originalModel)) reportPinnedFallback(fallback.event)
                pinnedFailure = {
                  status: streamError?.status ?? failed.status,
                  statusText: streamError ? "error event in stream" : failed.statusText,
                  errorBody: fallback.originalErrorBody ?? "",
                }
                response = fallback.response
                sentModel = SYNAPSE_AUTO_ROUTE
              }
            }
            if (response.ok) {
              // A 200 with empty content must not clear the failure streak (AIESC-02).
              // SSE streams are consumed downstream by the SDK; only buffered JSON bodies are checked here.
              const contentType = response.headers.get("content-type") || ""
              if (contentType.includes("application/json")) {
                const wire = await response.clone().json().catch(() => undefined)
                const message = wire?.choices?.[0]?.message
                const meaningful =
                  (message?.tool_calls?.length ?? 0) > 0 ||
                  (typeof message?.content === "string" && message.content.trim().length > 0)
                if (meaningful) escalations.recordSuccess(sessionKey)
                else escalations.recordFailure(sessionKey, "empty-content")
              } else {
                escalations.recordSuccess(sessionKey)
              }
            }

            if (!response.ok) {
              let errorBody = ""
              try {
                const cloned = response.clone()
                errorBody = await cloned.text()
              } catch {}
              // #80: the pinned model failed and `auto` failed too: log both, each under its own model.
              if (pinnedFailure) {
                sessionObserver.logDiagnostic(
                  {
                    timestamp: new Date().toISOString(),
                    type: "INFERENCE_ERROR",
                    error: `HTTP ${pinnedFailure.status}: ${pinnedFailure.errorBody || pinnedFailure.statusText}`,
                    details: {
                      status: pinnedFailure.status,
                      statusText: pinnedFailure.statusText,
                      errorBody: pinnedFailure.errorBody,
                      model: pinnedModel,
                    },
                  },
                  input.directory,
                )
              }
              sessionObserver.logDiagnostic(
                {
                  timestamp: new Date().toISOString(),
                  type: "INFERENCE_ERROR",
                  error: `HTTP ${response.status}: ${errorBody || response.statusText}`,
                  details: {
                    status: response.status,
                    statusText: response.statusText,
                    errorBody,
                    model: sentModel,
                    requestPreview: requestBodyJson ? JSON.stringify(requestBodyJson).slice(0, 1000) : undefined,
                  },
                },
                input.directory,
              )
              escalations.recordFailure(sessionKey, classifyFailure(response.status, errorBody))
            }

            const servedModel = response.headers.get("x-synapse-served-model")
            const costUsd = response.headers.get("x-synapse-cost-usd")
            const routedProvider = response.headers.get("x-synapse-routed-provider")
            const latencyMs = response.headers.get("x-synapse-latency-ms")

            if (servedModel) {
              latestSynapseServing = {
                model: servedModel,
                provider: routedProvider ?? undefined,
                costUsd: costUsd ?? undefined,
                latencyMs: latencyMs ?? undefined,
                timestamp: Date.now(),
              }
            }

            return response
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Sign in with Keystone (Alterspective SSO)",
          async authorize() {
            const nonce = generateState()
            const redirect = redirectUri(OAUTH_PORT)
            const url = buildHandoffLoginUrl({ redirectUri: redirect, nonce, loginUrl: options?.loginUrl })

            let server: ReturnType<typeof createServer> | undefined
            const callbackPromise = new Promise<{ handoff: string }>((resolve, reject) => {
              server = createServer((req, res) => {
                const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${OAUTH_PORT}`)
                if (reqUrl.pathname !== OAUTH_REDIRECT_PATH) return

                const queryError = reqUrl.searchParams.get("error")
                const queryErrorDescription = reqUrl.searchParams.get("error_description")
                if (queryError) {
                  res.writeHead(200, { "Content-Type": "text/html" })
                  res.end(
                    OauthCallbackPage.error(queryErrorDescription || queryError, { provider: "Keystone (Synapse)" }),
                  )
                  reject(new Error(queryErrorDescription || queryError))
                  return
                }

                const handoff = reqUrl.searchParams.get("handoff")
                if (!handoff) {
                  res.writeHead(400, { "Content-Type": "text/html" })
                  res.end(OauthCallbackPage.error("Missing handoff token.", { provider: "Keystone (Synapse)" }))
                  reject(new Error("Missing handoff token"))
                  return
                }

                // The handoff carries the nonce we generated; a mismatch means a
                // different login attempt and must not be accepted.
                const claims = parseJwtPayload(handoff)
                if (!claims || claims.nonce !== nonce) {
                  res.writeHead(400, { "Content-Type": "text/html" })
                  res.end(
                    OauthCallbackPage.error("Handoff nonce mismatch. Please try again.", { provider: "Keystone (Synapse)" }),
                  )
                  reject(new Error("Handoff nonce mismatch"))
                  return
                }

                res.writeHead(200, { "Content-Type": "text/html" })
                res.end(OauthCallbackPage.success({ provider: "Keystone (Synapse)" }))
                resolve({ handoff })
              })

              server.listen(OAUTH_PORT, "127.0.0.1")
            })

            await open(url).catch(() => undefined)

            return {
              url,
              instructions: "Sign in with your Alterspective account in the browser.",
              method: "auto" as const,
              async callback() {
                try {
                  const brokerKey = process.env[BROKER_KEY_ENV] || ""
                  if (!brokerKey) throw new Error(`${BROKER_KEY_ENV} is not set`)
                  const { handoff } = await callbackPromise
                  const tokens = await exchangeHandoffForSynapseToken({
                    handoff,
                    brokerKey,
                    tokenUrl: options?.tokenUrl,
                    audience,
                    offline: true,
                  })
                  return {
                    type: "success" as const,
                    provider: "synapse",
                    key: tokens.access_token,
                    metadata: {
                      clientId: HANDOFF_APP_ID,
                      clientSecret: process.env[CLIENT_SECRET_ENV] || "",
                      refreshToken: tokens.refresh_token || "",
                      expiresAt: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
                    },
                  }
                } catch {
                  return { type: "failed" as const }
                } finally {
                  // The browser needs a moment to finish rendering the callback
                  // page (and fetching its favicon). Closing the listener in the
                  // same tick made an otherwise successful login end on
                  // ERR_CONNECTION_REFUSED.
                  const listener = server
                  setTimeout(() => listener?.close(), 5000)
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "Paste Synapse API Key",
        },
      ],
    },
    event: async ({ event }) => {
      const sessionID =
        event.type === "session.idle" || event.type === "session.deleted"
          ? ((event.properties as any)?.sessionID || (event.properties as any)?.id)
          : undefined
      if (sessionID && (event.type === "session.idle" || event.type === "session.deleted")) {
        await sessionObserver.finalizeSessionRetrospective(sessionID, input.directory)
      }
      // AIESC follow-up (#15): completed sessions free their tracker slot.
      if (sessionID && event.type === "session.deleted") escalations.release(sessionID)
      // AIESC-02: a malformed native tool call (200 response, garbage tool name) is
      // invisible to the HTTP hooks; charge it here, deduped per part id.
      const hit = malformedToolCallFromEvent(event as { type: string; properties?: any })
      if (hit) {
        if (hit.partID) {
          if (countedMalformedParts.has(hit.partID)) return
          countedMalformedParts.add(hit.partID)
          if (countedMalformedParts.size > 500) {
          const oldestCounted = countedMalformedParts.values().next().value
          if (oldestCounted !== undefined) countedMalformedParts.delete(oldestCounted)
        }
        }
        escalations.recordFailure(hit.sessionID, "malformed-output")
      }
    },
    "tool.execute.before": async (toolInput, output) => {
      // 1. Policy Enforcement: Block raw browser scraping of corporate email / M365
      if (toolInput.tool.includes("playwright") || toolInput.tool.includes("browser")) {
        const rawUrl = String(output.args?.url || output.args?.Url || "")
        try {
          const parsed = new URL(rawUrl)
          const host = parsed.hostname.toLowerCase()
          const blockedDomains = [
            "office.com",
            "live.com",
            "microsoftonline.com",
            "sharepoint.com",
            "graph.microsoft.com",
          ]
          if (blockedDomains.some((d) => host === d || host.endsWith(`.${d}`))) {
            throw new Error(
              `[SECURITY & COMPLIANCE GATE] Direct browser automation to corporate service '${rawUrl}' is blocked. Corporate data access must go through the audited 'keystone-dynamic' MCP gateway (use search-tools -> get-tool-schema -> execute-tool).`,
            )
          }
        } catch (e: any) {
          if (e.message.startsWith("[SECURITY & COMPLIANCE GATE]")) throw e
        }
      }

      // 2. Keystone Dynamic Tool Name Normalization
      if (
        (toolInput.tool.includes("execute-tool") || toolInput.tool.includes("execute_tool")) &&
        output.args?.toolName
      ) {
        let name = String(output.args.toolName).trim()
        name = name.replace(/^(mcp__)?keystone[-_]dynamic[-_]/i, "")
        if (name === "search_tools" || name === "searchTools" || name === "search") {
          name = "search-tools"
        } else if (name === "get_tool_schema" || name === "getToolSchema" || name === "schema") {
          name = "get-tool-schema"
        }
        output.args.toolName = name
      }

      sessionObserver.onToolBefore(toolInput.sessionID, toolInput.callID, toolInput.tool, output.args)
    },
    // AIESC-02: a malformed native tool call (200 response, garbage tool name)
    // is a quality failure the HTTP-level hooks cannot see. Charge it here.
    "chat.headers": async (headerInput, headerOutput) => {
      headerOutput.headers["x-opencode-session"] = headerInput.sessionID
    },
    "tool.execute.after": async (toolInput, output) => {
      sessionObserver.onToolAfter(toolInput.sessionID, toolInput.callID, toolInput.tool, output.output)
    },
    "experimental.chat.system.transform": async (_input, output) => {
      const recentLearnings = await sessionObserver.getRecentLearnings(INJECTED_LEARNINGS_LIMIT, input.directory)
      if (escalations.atCap(_input.sessionID ?? input.directory)) {
        output.system.push(
          "AIESC-03: automatic escalation budget is exhausted for this session. Do NOT retry the same request shape. Present the failure evidence to the user and ask how to proceed.",
        )
      }
      const learningsBlock =
        recentLearnings.length > 0
          ? [
              "",
              "## Learned Operating Rules & Past Corrections (DO NOT REPEAT THESE MISTAKES):",
              ...recentLearnings.map((l) => `- ${l.lesson}`),
            ]
          : []

      output.system.push(
        [
          "## Mandatory Keystone Dynamic MCP Gateway Instructions",
          "All corporate MCP tools (Microsoft 365 Email/Calendar/Teams, Keystone Admin, RAG, CRM, etc.) are centralized in `keystone-dynamic`.",
          "To access corporate tools:",
          "1. SEARCH: Call `keystone-dynamic_search-tools` with `{\"query\": \"mail\"}` or `{\"query\": \"email\"}` or `{\"query\": \"calendar\"}`.",
          "2. SCHEMA: Call `keystone-dynamic_get-tool-schema` with `{\"toolName\": \"<exact_name_from_search>\"}`.",
          "3. EXECUTE: Call `keystone-dynamic_execute-tool` with `{\"toolName\": \"<exact_name>\", \"arguments\": { ... }}`.",
          "- STRICT RULE: Do NOT guess tool names (e.g. `m365__list-emails` is invalid). Always search first with `search-tools`.",
          "- STRICT SECURITY GATE: NEVER use Playwright / browser tools to navigate to `outlook.office.com`, `login.microsoftonline.com`, or other corporate web apps. All corporate operations MUST use Keystone to maintain audit compliance.",
          "",
          "## On-Premises Quality & Code Buddy Reviewer",
          "You have access to the free on-premises specialist tool `synapse_buddy_review`.",
          "When you write code, add functions, or make non-trivial edits, call `synapse_buddy_review` with your code snippet or diff to get an instant ($0 cost) audit for syntax, security vulnerabilities, and logic flaws before declaring complete.",
          "",
          "## On-Premises Swarm Explorer & Sub-Agents",
          "For large research tasks, codebase migrations, or surveying multiple directories, launch parallel sub-agents using the `task` tool (`explore`, `gemini`, `coder`, `fable`, `glm`, `sol`) to divide and conquer concurrently at $0 on-prem cost.",
          "",
          "## Mandatory Tool Execution Protocol",
          "You are equipped with tools: `read`, `edit`, `write`, `glob`, `grep`, `bash`, `task`, `alterspective-rag`, `keystone-dynamic`, `synapse_buddy_review`, etc.",
          "1. PREFER NATIVE TOOLS: Always use `read`, `write`, `edit`, `glob`, `grep` directly instead of executing shell commands via `bash` for file reading and writing.",
          "2. WINDOWS POWERSHELL RULES: When using `bash` on Windows, do NOT use Linux utilities (`head`, `tail`, `grep`, `ls`, `cat`). Use PowerShell native commands (`Select-Object -First N`, `Select-String`, `Get-ChildItem`, `Get-Content`).",
          "3. CONTINUOUS EXECUTION: NEVER end your turn saying 'Let me check...' or 'Let me search...' without calling the tool in the same turn.",
          "4. FINISH THE JOB: Continue executing tools step-by-step until the requested task is completely done. Only stop when the full work is finished and verified.",
          "5. EXACT TOOL NAMES & ERROR RECOVERY: Use registered tool names (`alterspective-rag_rag_ask`, `alterspective-rag_rag_search`, `keystone-dynamic_execute-tool`, `read`, `write`, `edit`). If a tool fails, immediately recover and continue in the same turn without stopping.",
          ...(bridgeMode
            ? [
                "To invoke a tool, output:",
                "<" + "tool_call>",
                '{"name": "<tool_name>", "arguments": { ... }}',
                "<" + "/tool_call>",
                "Execute tools immediately to take real action.",
              ]
            : [
                "Invoke tools ONLY through your native function calling. NEVER write tool calls as text - text tool calls are never executed.",
              ]),
          ...learningsBlock,
        ].join("\n"),
      )
      // vLLM rejects a second system message. The fetch wrapper's normalizeSystemMessages
      // only runs when a `synapse` auth entry is stored; a config/env apiKey (the delegate box)
      // skips the loader entirely. Fold here so every auth path sends one system message.
      if (_input.model?.providerID === "synapse") foldSystemBlocks(output.system)
    },
    tool: {
      synapse_record_learning: tool({
        description:
          "Record a learned rule, mistake correction, or user preference into persistent memory so the AI remembers and adheres to it in all future sessions.",
        args: {
          lesson: tool.schema
            .string()
            .describe("The actionable lesson or correction (e.g. 'Always run typecheck before finishing')."),
          context: tool.schema.string().optional().describe("Optional context or file where this applies."),
        },
        async execute(args) {
          if (!args.lesson || !args.lesson.trim()) {
            return "Please provide a valid lesson description."
          }
          await sessionObserver.recordLearning(
            {
              lesson: args.lesson.trim(),
              context: args.context,
              source: "user_feedback",
            },
            input.directory,
          )
          return `✅ Successfully recorded rule: "${args.lesson}". This knowledge is stored and will automatically guide future sessions.`
        },
      }),
      synapse_list_rules: tool({
        description:
          "List the operating rules (learnings) this agent follows, showing where each is stored and whether it is actually injected into the system prompt. Use when the user asks what rules you are following, or to audit a behaviour such as a language preference.",
        args: {},
        async execute() {
          const rules = await sessionObserver.listLearnings(input.directory)
          const paths = learningStorePaths(input.directory)
          const injected = rules.filter((r) => r.injected).length
          const line = (r: (typeof rules)[number]) =>
            "  " +
            (r.injected ? "[injected]" : "[stored]  ") +
            " " +
            r.lesson +
            "  (" +
            r.source +
            ", recorded " +
            r.timestamp +
            ")"
          const group = (title: string, file: string | undefined, origin: "global" | "project") => {
            const rows = rules.filter((r) => r.origin === origin)
            return [title + "  " + (file ?? "(unavailable)"), ...(rows.length > 0 ? rows.map(line) : ["  (none)"])]
          }
          return [
            injected +
              " of " +
              rules.length +
              " recorded rule(s) are injected into this session (the most recent " +
              INJECTED_LEARNINGS_LIMIT +
              ", project rules first).",
            ...group("Project - this repo only:", paths.project, "project"),
            ...group("Global - every project on this machine:", paths.global, "global"),
          ].join("\n")
        },
      }),
      synapse_forget_rule: tool({
        description:
          "Remove an operating rule (learning) by matching text, so the agent stops applying it. Use when the user asks to stop doing something previously recorded, e.g. 'stop greeting me in French'.",
        args: {
          lesson: tool.schema
            .string()
            .describe("Text identifying the rule to remove (case-insensitive substring match)."),
        },
        async execute(args) {
          const needle = (args.lesson || "").trim()
          if (!needle) return "Please provide the rule text to remove."
          const removed = await sessionObserver.forgetLearning(needle, input.directory)
          return removed > 0
            ? 'Removed ' + removed + ' rule(s) matching "' + needle + '". They will not be applied in future sessions.'
            : 'No rule matched "' + needle + '". Use synapse_list_rules to see the recorded rules.'
        },
      }),      synapse_buddy_review: tool({
        description:
          "Run an instant, $0-cost on-premises code review using the Synapse Coder specialist. Checks code snippets or files for syntax errors, SQL injection, broken imports, and security defects.",
        args: {
          code: tool.schema.string().describe("The code content or patch to review."),
          context: tool.schema
            .string()
            .optional()
            .describe("Optional context or specific concerns (e.g. 'check auth flow')."),
        },
        async execute(args) {
          if (!args.code || !args.code.trim()) {
            return "Please provide code content or a file path to review."
          }

          let codeToReview = args.code
          let effectiveContext = args.context

          // Auto-File Resolution: If args.code is a path to an existing file, load its content
          const trimmed = args.code.trim()
          const cleanPath = trimmed.replace(/^file:\/\/\/?/, "").replace(/^["']|["']$/g, "").trim()
          if (!cleanPath.includes("\n") && (cleanPath.includes(".") || cleanPath.includes("/") || cleanPath.includes("\\"))) {
            try {
              const targetPath = path.isAbsolute(cleanPath)
                ? cleanPath
                : path.join(input.directory || process.cwd(), cleanPath)
              const fileContent = await fs.readFile(targetPath, "utf8")
              codeToReview = fileContent
              effectiveContext = effectiveContext ? `${effectiveContext} (File: ${cleanPath})` : `File: ${cleanPath}`
            } catch {}
          }

          if (codeToReview.length > 50_000) {
            codeToReview = codeToReview.slice(0, 50_000) + "\n\n...[Truncated for Review]"
          }

          let token = ""
          try {
            const homedir = os.homedir()
            const authPath = path.join(homedir, ".local", "share", "opencode", "auth.json")
            const authContent = JSON.parse(await fs.readFile(authPath, "utf8"))
            token = authContent.synapse?.key || authContent.synapse?.access_token || ""
          } catch {}

          if (!token) {
            return "Synapse is not authenticated. Please run /login first."
          }

          const reviewPrompt = [
            {
              role: "system",
              content:
                "You are the Synapse On-Premises Buddy Reviewer. Audit the provided code for:\n1. Syntax & type safety\n2. Security vulnerabilities (injection, hardcoded secrets, missing CSRF/auth)\n3. Broken imports & unhandled edge cases\nReturn a concise summary with 'STATUS: PASSED' or 'STATUS: ISSUES DETECTED' followed by concise bullet points.",
            },
            {
              role: "user",
              content: `${effectiveContext ? `Context: ${effectiveContext}\n\n` : ""}Code to review:\n\`\`\`\n${codeToReview}\n\`\`\``,
            },
          ]

          try {
            const res = await fetch("https://synapse-mcp.alterspective.com.au/mcp", {
              method: "POST",
              signal: AbortSignal.timeout(30_000),
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: Date.now(),
                method: "tools/call",
                params: {
                  name: "chat",
                  arguments: {
                    messages: reviewPrompt,
                    taskType: "code",
                  },
                },
              }),
            })

            if (!res.ok) {
              return `Buddy review call failed with HTTP ${res.status}`
            }

            const raw = await res.text()
            let content = ""
            for (const line of raw.split("\n")) {
              if (line.startsWith("data:")) {
                try {
                  const data = JSON.parse(line.slice(5).trim())
                  if (data.result?.structuredContent?.content) {
                    content = data.result.structuredContent.content
                  } else if (data.result?.content?.[0]?.text) {
                    try {
                      const inner = JSON.parse(data.result.content[0].text)
                      content = inner.content || data.result.content[0].text
                    } catch {
                      content = data.result.content[0].text
                    }
                  }
                } catch {}
              }
            }

            const finalContent = content.trim() || "Buddy review completed: No issues found."

            // If issues were detected, auto-record the correction learning
            if (finalContent.includes("ISSUES") || finalContent.includes("ISSUE DETECTED")) {
              void sessionObserver.recordLearning(
                {
                  lesson: `Buddy Review finding in ${args.context || "code"}: ${finalContent.slice(0, 150)}...`,
                  context: args.context,
                  source: "buddy_review",
                },
                input.directory,
              )
            }

            return finalContent
          } catch (err: any) {
            return `Buddy review error: ${err.message}`
          }
        },
      }),
      synapse_probe: tool({
        description: "Check the last Synapse AI model routing, provider destination, and inference cost telemetry.",
        args: {},
        async execute() {
          if (!latestSynapseServing) {
            return "Synapse is connected. No inference requests have completed in this session yet."
          }
          const costText = latestSynapseServing.costUsd ? ` | Cost: $${latestSynapseServing.costUsd}` : ""
          const providerText = latestSynapseServing.provider ? ` via ${latestSynapseServing.provider}` : ""
          const latencyText = latestSynapseServing.latencyMs ? ` (${latestSynapseServing.latencyMs}ms)` : ""
          return `Active Synapse Model: ${latestSynapseServing.model}${providerText}${latencyText}${costText}`
        },
      }),
      session_retrospective_summary: tool({
        description: "Retrieve recent session retrospectives, learning points, and compliance/audit bypass warnings.",
        args: {},
        async execute() {
          const retros = sessionObserver.getLatestRetrospectives()
          if (retros.length === 0) {
            return "No session retrospectives have completed yet."
          }
          return JSON.stringify(retros.slice(0, 5), null, 2)
        },
      }),
      session_diagnostics: tool({
        description: "Inspect recent inference requests, errors, and session diagnostic logs.",
        args: {},
        async execute() {
          const logs = sessionObserver.getDiagnosticLogs()
          if (logs.length === 0) {
            return "No diagnostic log entries recorded yet."
          }
          return JSON.stringify(logs.slice(0, 10), null, 2)
        },
      }),
    },
  }
}



