// HTTP client for svc-coding-agent.
import { DelegateError } from "../shared/errors.ts"
import type { RemoteTask, StartRemoteTaskRequest } from "./types.ts"
import type { RemoteObservation, RemoteReadiness } from "../tools/context.ts"

export type RemoteClientOptions = {
  baseUrl: string
  token?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export type RemoteCodingAgentClient = {
  health(): Promise<{ healthy: boolean; status?: number; error?: string }>
  readiness(): Promise<RemoteReadiness>
  startTask(req: StartRemoteTaskRequest): Promise<RemoteTask>
  getTask(id: string): Promise<RemoteTask>
  getPatch(id: string): Promise<string>
  cancelTask(id: string): Promise<{ cancelled: boolean }>
}

/** Diagnostics never use resolveToken: a read must not mint a wider canary grant. */
async function observeRemote(fetchFn: typeof fetch, url: string, kind: "health" | "authentication", timeoutMs: number, token?: string): Promise<RemoteObservation> {
  const observedAt = new Date().toISOString()
  const startedAt = Date.now()
  const finish = (outcome: RemoteObservation["outcome"], httpStatus?: number, shapeValid?: boolean): RemoteObservation => ({
    observedAt,
    elapsedMs: Date.now() - startedAt,
    outcome,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(shapeValid === undefined ? {} : { shapeValid }),
  })
  if (kind === "authentication" && !token?.trim()) return finish("needs_auth")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json", ...(kind === "authentication" ? { Authorization: `Bearer ${token}` } : {}) },
      redirect: "error",
      signal: controller.signal,
    })
    if (!response.ok)
      return finish(kind === "authentication" && (response.status === 401 || response.status === 403) ? "needs_auth" : "http_error", response.status)
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return finish(controller.signal.aborted ? "timeout" : "invalid_json", response.status, false)
    }
    const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
    if (kind === "health") {
      if (!isRecord(parsed) || parsed.service !== "svc-coding-agent" || typeof parsed.status !== "string") return finish("invalid_shape", response.status, false)
      if (parsed.status === "healthy" || parsed.status === "degraded" || parsed.status === "unhealthy") return finish(parsed.status, response.status, true)
      return finish("unknown", response.status, false)
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.repos)) return finish("invalid_shape", response.status, false)
    const valid = parsed.repos.every((repo: unknown) => isRecord(repo) && typeof repo.repo === "string" && typeof repo.repoClass === "string" && typeof repo.residency === "string")
    return finish(valid ? "authenticated" : "invalid_shape", response.status, valid)
  } catch {
    return finish(controller.signal.aborted ? "timeout" : "unreachable")
  } finally {
    clearTimeout(timer)
  }
}

let cachedCanaryToken: { token: string; expiresAt: number } | undefined

async function resolveToken(options: RemoteClientOptions, fetchFn: typeof fetch): Promise<string | undefined> {
  if (options.token) return options.token
  const secret = process.env.KEYSTONE_CANARY_CLIENT_SECRET || process.env.CANARY_CLIENT_SECRET
  if (secret) {
    const now = Date.now()
    if (cachedCanaryToken && cachedCanaryToken.expiresAt > now + 60_000) {
      return cachedCanaryToken.token
    }
    const tokenUrl = "https://identity.alterspective.com.au/api/oidc/token"
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "svc-coding-agent-staging-canary",
      client_secret: secret,
      audience: "svc-coding-agent-staging",
      scope: "coding:admin",
    })
    const res = await fetchFn(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    })
    if (!res.ok) {
      const err = await res.text().catch(() => "")
      throw new DelegateError("needs_auth", "Failed to acquire Keystone token using client secret.", "Check client secret.", err.slice(0, 200))
    }
    const data = (await res.json()) as { access_token: string; expires_in?: number }
    const expiresInMs = (data.expires_in ?? 3600) * 1000
    cachedCanaryToken = { token: data.access_token, expiresAt: now + expiresInMs }
    return data.access_token
  }
  return undefined
}

export function createRemoteClient(options: RemoteClientOptions): RemoteCodingAgentClient {
  const base = options.baseUrl.replace(/\/+$/, "")
  const timeoutMs = options.timeoutMs ?? 30_000
  const fetchFn = options.fetch ?? globalThis.fetch

  async function getHeaders(): Promise<Record<string, string>> {
    const token = await resolveToken(options, fetchFn)
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${base}${path.startsWith("/") ? path : `/${path}`}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const headers = {
      ...(await getHeaders()),
      ...(init.headers as Record<string, string> | undefined),
    }

    let res: Response
    try {
      res = await fetchFn(url, {
        ...init,
        headers,
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
      const observed = await observeRemote(fetchFn, `${base}/health`, "health", timeoutMs)
      return { healthy: observed.outcome === "healthy", ...(observed.httpStatus === undefined ? {} : { status: observed.httpStatus }), ...(observed.outcome === "healthy" ? {} : { error: observed.outcome }) }
    },

    async readiness() {
      const [health, authentication] = await Promise.all([
        observeRemote(fetchFn, `${base}/health`, "health", timeoutMs),
        observeRemote(fetchFn, `${base}/api/v1/repos`, "authentication", timeoutMs, options.token),
      ])
      return { health, authentication }
    },

    async startTask(req: StartRemoteTaskRequest): Promise<RemoteTask> {
      const payload = {
        ...req,
        idempotencyKey: req.idempotencyKey ?? `idemp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      }
      const raw = await request<RemoteTask & { taskId?: string }>("/api/v1/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      })
      return {
        ...raw,
        id: (raw.id ?? raw.taskId) as string,
      }
    },

    async getTask(id: string): Promise<RemoteTask> {
      const raw = await request<RemoteTask & { taskId?: string }>(`/api/v1/tasks/${encodeURIComponent(id)}`, {
        method: "GET",
      })
      return {
        ...raw,
        id: (raw.id ?? raw.taskId) as string,
      }
    },

    async getPatch(id: string): Promise<string> {
      const url = `${base}/api/v1/tasks/${encodeURIComponent(id)}/patch`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let res: Response
      try {
        const headers = { ...(await getHeaders()), Accept: "text/plain, application/json" }
        res = await fetchFn(url, {
          headers,
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
        const json = (await res.json()) as { patch?: string; untrusted?: { patch?: string } }
        return json.untrusted?.patch ?? json.patch ?? ""
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
