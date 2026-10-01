// Thin typed client for the boxed `opencode serve` HTTP API.
// Owned here (not the generated SDK) so the bridge has no dependency on the monorepo install.
// Every call carries basic auth, the session directory, and a correlation id (OBS-ID-01/04).
// Every call has a deadline (review A-14): default 30 s, overridable per client and per call.
// Every body is read with a byte cap (review W3C-07): default 8 MB, overridable per client and call.
import { DelegateError, isDelegateError } from "./errors.ts"

export type ApiTarget = { baseUrl: string; password: string; username?: string }

export type McpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "needs_auth" }
  | { status: "failed"; error: string }
  | { status: "needs_client_registration"; error: string }

export type SessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string }

export type Call = {
  method?: "GET" | "POST" | "PATCH" | "DELETE"
  path: string
  directory?: string
  body?: unknown
  correlationId?: string
  /** Deadline for this call (request and body). Default: the client's timeout. */
  timeoutMs?: number
  /** Largest response body this call accepts, in bytes. Default: the client's cap. */
  maxBytes?: number
}

export type OpencodeApi = {
  call<T>(input: Call): Promise<{ status: number; data: T | undefined }>
}

export const DEFAULT_API_TIMEOUT_MS = 30_000

/** 8 MB: far above any real OpenCode API answer, far below what would hurt the bridge. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export type ApiOptions = { timeoutMs?: number; maxResponseBytes?: number }

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
}

/** fetch with redirect:"error" throws on a 3xx: Bun sets code UnexpectedRedirect, undici says "redirect". */
export function isRedirectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = "code" in error ? error.code : undefined
  const cause = error.cause instanceof Error ? error.cause.message : ""
  return code === "UnexpectedRedirect" || /redirect/i.test(error.message) || /redirect/i.test(cause)
}

/** The box answered with a redirect: the bridge never follows one off the box it was given (W2C-02). */
function redirectRefused(detail: string): DelegateError {
  return new DelegateError("upstream_error", "The delegate server answered with a redirect, which the bridge refuses.", "Run oc_doctor.", detail)
}

function unreachable(error: unknown): DelegateError {
  const detail = isTimeout(error) ? "timeout" : String(error)
  const message = isTimeout(error) ? "The delegate server did not answer in time." : "The delegate server is not reachable."
  return new DelegateError("server_down", message, "Run oc_doctor.", detail)
}

function tooLarge(cap: number): DelegateError {
  return new DelegateError("upstream_error", "The delegate server sent a response that is too large.", "Retry with a smaller limit; if it repeats, run oc_doctor.", `body over ${cap} bytes`)
}

/** Settles with `work`, or rejects with the signal's reason once it fires (whatever `work` does). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

/**
 * The body as text, streamed with a byte cap. The deadline is enforced here too, not only by
 * fetch: an injected fetch (or a body stream) may ignore the signal.
 */
async function readCapped(res: Response, cap: number, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => undefined)
    throw tooLarge(cap)
  }
  if (!res.body) return ""
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal)
      if (done) break
      total += value.byteLength
      if (total > cap) throw tooLarge(cap)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  // TextDecoder, like Response.text(): UTF-8, a leading BOM dropped, bad bytes replaced.
  return new TextDecoder().decode(Buffer.concat(chunks))
}

export function createApi(target: ApiTarget, fetchImpl: typeof fetch = fetch, options: ApiOptions = {}): OpencodeApi {
  const auth = "Basic " + Buffer.from(`${target.username ?? "opencode"}:${target.password}`).toString("base64")
  const clientTimeout = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS
  const clientCap = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  return {
    async call<T>(input: Call) {
      const url = new URL(input.path, target.baseUrl)
      if (input.directory) url.searchParams.set("directory", input.directory)
      const headers: Record<string, string> = { authorization: auth }
      if (input.body !== undefined) headers["content-type"] = "application/json"
      if (input.correlationId) headers["x-correlation-id"] = input.correlationId
      const signal = AbortSignal.timeout(input.timeoutMs ?? clientTimeout)
      let status: number
      let text: string
      try {
        const res = await untilAborted(fetchImpl(url, { method: input.method ?? "GET", headers, signal, redirect: "error", body: input.body === undefined ? undefined : JSON.stringify(input.body) }), signal)
        status = res.status
        text = await readCapped(res, input.maxBytes ?? clientCap, signal)
      } catch (error) {
        if (isDelegateError(error)) throw error
        throw isRedirectError(error) ? redirectRefused("redirect") : unreachable(error)
      }
      if (status >= 300 && status < 400) throw redirectRefused(`HTTP ${status}`)
      if (status === 401) {
        throw new DelegateError("auth_mismatch", "The delegate server rejected the bridge's credentials.", "Restart the bridge so it and the box share one password (oc_doctor).", "HTTP 401")
      }
      return { status, data: text ? (safeJson(text) as T | undefined) : undefined }
    },
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function expectOk<T>(result: { status: number; data: T | undefined }, what: string): T {
  if (result.status >= 200 && result.status < 300 && result.data !== undefined) return result.data
  throw new DelegateError("upstream_error", `The delegate server failed to ${what}.`, "Retry; if it repeats, run oc_doctor.", `HTTP ${result.status}`)
}
