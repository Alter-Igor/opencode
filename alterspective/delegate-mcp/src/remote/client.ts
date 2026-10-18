// HTTP client for svc-coding-agent.
import { DelegateError } from "../shared/errors.ts"
import type { RemoteTask, StartRemoteTaskRequest } from "./types.ts"

export type RemoteClientOptions = {
  baseUrl: string
  token?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export type RemoteCodingAgentClient = {
  health(): Promise<{ healthy: boolean; status?: number; error?: string }>
  startTask(req: StartRemoteTaskRequest): Promise<RemoteTask>
  getTask(id: string): Promise<RemoteTask>
  getPatch(id: string): Promise<string>
  cancelTask(id: string): Promise<{ cancelled: boolean }>
}

export function createRemoteClient(options: RemoteClientOptions): RemoteCodingAgentClient {
  const base = options.baseUrl.replace(/\/+$/, "")
  const timeoutMs = options.timeoutMs ?? 30_000
  const fetchFn = options.fetch ?? globalThis.fetch

  const headers = (): Record<string, string> => ({
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
  })

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${base}${path.startsWith("/") ? path : `/${path}`}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetchFn(url, {
        ...init,
        headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) },
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      const isAbort = err instanceof Error && err.name === "AbortError"
      throw new DelegateError(
        "server_down",
        isAbort ? "Remote coding agent timed out." : "Remote coding agent is unreachable.",
        "Check your network and OPENCODE_DELEGATE_REMOTE_URL.",
        String(err),
      )
    }
    clearTimeout(timer)

    if (res.status === 404) {
      throw new DelegateError("not_found", "The requested remote resource was not found.", "Verify task ID and retry.", `HTTP 404 ${url}`)
    }
    if (res.status === 401 || res.status === 403) {
      throw new DelegateError("needs_auth", "Authentication failed with the remote coding agent.", "Ensure your Keystone token or OPENCODE_DELEGATE_REMOTE_TOKEN is set.", `HTTP ${res.status}`)
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      throw new DelegateError("upstream_error", `Remote coding agent returned error (${res.status}).`, "Inspect error detail and retry.", errText.slice(0, 300))
    }

    const contentType = res.headers.get("content-type") ?? ""
    if (contentType.includes("application/json")) {
      return (await res.json()) as T
    }
    return (await res.text()) as unknown as T
  }

  return {
    async health() {
      try {
        const url = `${base}/health`
        const res = await fetchFn(url, { headers: headers(), method: "GET" })
        return { healthy: res.ok, status: res.status }
      } catch (err) {
        return { healthy: false, error: String(err) }
      }
    },

    async startTask(req: StartRemoteTaskRequest): Promise<RemoteTask> {
      return request<RemoteTask>("/api/v1/tasks", {
        method: "POST",
        body: JSON.stringify(req),
      })
    },

    async getTask(id: string): Promise<RemoteTask> {
      return request<RemoteTask>(`/api/v1/tasks/${encodeURIComponent(id)}`, {
        method: "GET",
      })
    },

    async getPatch(id: string): Promise<string> {
      const url = `${base}/api/v1/tasks/${encodeURIComponent(id)}/patch`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let res: Response
      try {
        res = await fetchFn(url, {
          headers: { ...headers(), Accept: "text/plain, application/json" },
          signal: controller.signal,
        })
      } catch (err) {
        clearTimeout(timer)
        throw new DelegateError("server_down", "Failed to retrieve patch from remote coding agent.", "Verify network connectivity.", String(err))
      }
      clearTimeout(timer)

      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new DelegateError("upstream_error", `Failed to get patch (${res.status}).`, "Check task status.", text.slice(0, 300))
      }

      const contentType = res.headers.get("content-type") ?? ""
      if (contentType.includes("application/json")) {
        const json = (await res.json()) as { patch?: string }
        return json.patch ?? ""
      }
      return res.text()
    },

    async cancelTask(id: string): Promise<{ cancelled: boolean }> {
      return request<{ cancelled: boolean }>(`/api/v1/tasks/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      })
    },
  }
}
