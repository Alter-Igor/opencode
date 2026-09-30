// Thin typed client for the boxed `opencode serve` HTTP API.
// Owned here (not the generated SDK) so the bridge has no dependency on the monorepo install.
// Every call carries basic auth, the session directory, and a correlation id (OBS-ID-01/04).
import { DelegateError } from "./errors.ts"

export type ApiTarget = { baseUrl: string; password: string; username?: string }

export type McpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "needs_auth" }
  | { status: "failed"; error: string }
  | { status: "needs_client_registration"; error: string }

export type SessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string }

type Call = { method?: "GET" | "POST" | "PATCH" | "DELETE"; path: string; directory?: string; body?: unknown; correlationId?: string }

export type OpencodeApi = {
  call<T>(input: Call): Promise<{ status: number; data: T | undefined }>
}

export function createApi(target: ApiTarget, fetchImpl: typeof fetch = fetch): OpencodeApi {
  const auth = "Basic " + Buffer.from(`${target.username ?? "opencode"}:${target.password}`).toString("base64")
  return {
    async call<T>(input: Call) {
      const url = new URL(input.path, target.baseUrl)
      if (input.directory) url.searchParams.set("directory", input.directory)
      const headers: Record<string, string> = { authorization: auth }
      if (input.body !== undefined) headers["content-type"] = "application/json"
      if (input.correlationId) headers["x-correlation-id"] = input.correlationId
      let res: Response
      try {
        res = await fetchImpl(url, { method: input.method ?? "GET", headers, body: input.body === undefined ? undefined : JSON.stringify(input.body) })
      } catch (error) {
        throw new DelegateError("server_down", "The delegate server is not reachable.", "Run oc_doctor.", String(error))
      }
      const text = await res.text()
      if (res.status === 401) throw new DelegateError("server_down", "The delegate server refused the bridge's credentials.", "Restart the bridge (oc_doctor).")
      return { status: res.status, data: text ? (safeJson(text) as T | undefined) : undefined }
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
