import { describe, expect, it } from "bun:test"
import { createRemoteClient } from "../src/remote/client.ts"
import type { RemoteTask } from "../src/remote/types.ts"

// These fixtures implement the callable fetch seam; Bun's optional preconnect is never used.
const fixtureFetch = (call: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) => call as typeof fetch

describe("RemoteCodingAgentClient", () => {
  it.each([
    [{ service: "svc-coding-agent", status: "degraded" }, "degraded"],
    [{ service: "svc-coding-agent", status: "unhealthy" }, "unhealthy"],
    [{ service: "svc-coding-agent", status: "new-status" }, "unknown"],
    [{ service: "svc-coding-agent" }, "invalid_shape"],
    [null, "invalid_shape"],
    [[], "invalid_shape"],
    [{ service: "wrong-service", status: "healthy" }, "invalid_shape"],
  ] as const)("validates health body %j without promoting unknown evidence", async (body, outcome) => {
    const client = createRemoteClient({ baseUrl: "https://fixture.invalid", fetch: fixtureFetch(async () => Response.json(body, { status: 203 })) })
    expect((await client.readiness()).health).toMatchObject({ outcome, httpStatus: 203 })
    expect((await client.health()).healthy).toBe(false)
  })

  it("keeps a valid empty catalog, actual status and anonymous health separate", async () => {
    const requests: Array<{ path: string; auth: string | null; method?: string; redirect?: RequestRedirect }> = []
    const client = createRemoteClient({ baseUrl: "https://fixture.invalid", token: "fixture-token", fetch: fixtureFetch(async (url, init) => {
      const pathname = new URL(String(url)).pathname
      requests.push({ path: pathname, auth: new Headers(init?.headers).get("authorization"), method: init?.method, redirect: init?.redirect })
      return Response.json(pathname === "/health" ? { service: "svc-coding-agent", status: "healthy" } : { repos: [] }, { status: 203 })
    }) })
    const observed = await client.readiness()
    expect(observed.health).toMatchObject({ outcome: "healthy", httpStatus: 203, shapeValid: true })
    expect(observed.authentication).toMatchObject({ outcome: "authenticated", httpStatus: 203, shapeValid: true })
    expect(requests).toEqual([{ path: "/health", auth: null, method: "GET", redirect: "error" }, { path: "/api/v1/repos", auth: "Bearer fixture-token", method: "GET", redirect: "error" }])
  })

  it.each([{ repos: "SENTINEL" }, { repos: [null] }, { repos: [{ repo: "SENTINEL", repoClass: "org" }] }, { repos: [{ repo: "SENTINEL", repoClass: "org", residency: 7 }] }])("rejects a malformed catalog and retains no body %j", async (body) => {
    const client = createRemoteClient({ baseUrl: "https://fixture.invalid", token: "fixture-token", fetch: fixtureFetch(async () => Response.json(body)) })
    const observed = await client.readiness()
    expect(observed.authentication).toMatchObject({ outcome: "invalid_shape", httpStatus: 200, shapeValid: false })
    expect(JSON.stringify(observed)).not.toContain("SENTINEL")
  })

  it("redacts malformed JSON, HTTP errors and thrown transport errors", async () => {
    const malformed = createRemoteClient({ baseUrl: "https://fixture.invalid", token: "fixture-token", fetch: fixtureFetch(async () => new Response("SENTINEL_NOT_JSON")) })
    const observed = await malformed.readiness()
    expect(observed.health).toMatchObject({ outcome: "invalid_json", httpStatus: 200 })
    expect(observed.authentication).toMatchObject({ outcome: "invalid_json", httpStatus: 200 })
    const failed = createRemoteClient({ baseUrl: "https://fixture.invalid", token: "fixture-token", fetch: fixtureFetch(async () => new Response("SENTINEL_ERROR_BODY", { status: 503 })) })
    expect((await failed.readiness()).health).toMatchObject({ outcome: "http_error", httpStatus: 503 })
    const down = createRemoteClient({ baseUrl: "https://fixture.invalid", token: "fixture-token", fetch: fixtureFetch(async () => { throw new Error("SENTINEL_TRANSPORT") }) })
    const unreachable = await down.readiness()
    expect(unreachable.health.outcome).toBe("unreachable")
    expect(unreachable.authentication.outcome).toBe("unreachable")
    expect(JSON.stringify([observed, await failed.readiness(), unreachable])).not.toContain("SENTINEL")
  })

  it.each(["headers", "body"])("bounds the entire %s read and preserves only observed status", async (phase) => {
    const client = createRemoteClient({ baseUrl: "https://fixture.invalid", token: "fixture-token", timeoutMs: 20, fetch: fixtureFetch(async (_url, init) => {
      if (phase === "headers") return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("SENTINEL", "AbortError")), { once: true }))
      return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new DOMException("SENTINEL", "AbortError")), { once: true }) } }), { status: 203 })
    }) })
    const observed = await client.readiness()
    expect(observed.health.outcome).toBe("timeout")
    expect(observed.authentication.outcome).toBe("timeout")
    expect(observed.health.httpStatus).toBe(phase === "body" ? 203 : undefined)
    expect(observed.authentication.httpStatus).toBe(phase === "body" ? 203 : undefined)
    expect(JSON.stringify(observed)).not.toContain("SENTINEL")
  }, 2000)

  it("calls health endpoint correctly", async () => {
    const mockFetch = (async (url: unknown) => {
      expect(String(url)).toBe("https://coding.test.local/health")
      return new Response(JSON.stringify({ service: "svc-coding-agent", status: "healthy" }), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as unknown as typeof fetch

    const client = createRemoteClient({
      baseUrl: "https://coding.test.local",
      fetch: mockFetch,
    })
    const health = await client.health()
    expect(health.healthy).toBe(true)
    expect(health.status).toBe(200)
  })

  it("handles health failure gracefully", async () => {
    const mockFetch = (async () => {
      throw new Error("connection refused")
    }) as unknown as typeof fetch

    const client = createRemoteClient({
      baseUrl: "https://coding.test.local",
      fetch: mockFetch,
    })
    const health = await client.health()
    expect(health.healthy).toBe(false)
    expect(health.error).toBe("unreachable")
  })

  it("starts a remote task with direct-patch publishMode and seedPatch", async () => {
    let capturedBody: unknown
    let capturedAuth = ""

    const mockFetch = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe("https://coding.test.local/api/v1/tasks")
      expect(init?.method).toBe("POST")
      capturedBody = JSON.parse(String(init?.body))
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? ""

      const task: RemoteTask = {
        id: "task_test_123",
        repo: "owner/repo",
        goal: "implement feature",
        state: "queued",
        publishMode: "direct-patch",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      return new Response(JSON.stringify(task), { status: 201, headers: { "Content-Type": "application/json" } })
    }) as unknown as typeof fetch

    const client = createRemoteClient({
      baseUrl: "https://coding.test.local",
      token: "secret-token",
      fetch: mockFetch,
    })

    const task = await client.startTask({
      repo: "owner/repo",
      goal: "implement feature",
      publishMode: "direct-patch",
      seedPatch: { patch: "diff --git a/file b/file" },
    })

    expect(task.id).toBe("task_test_123")
    expect(task.state).toBe("queued")
    expect(capturedAuth).toBe("Bearer secret-token")
    expect((capturedBody as Record<string, unknown>).publishMode).toBe("direct-patch")
  })

  it("gets task status and returns parsed task", async () => {
    const mockFetch = (async (url: unknown) => {
      expect(String(url)).toBe("https://coding.test.local/api/v1/tasks/task_test_123")
      const task: RemoteTask = {
        id: "task_test_123",
        repo: "owner/repo",
        goal: "implement feature",
        state: "done",
        result: { outcome: "patch" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as unknown as typeof fetch

    const client = createRemoteClient({
      baseUrl: "https://coding.test.local",
      fetch: mockFetch,
    })

    const task = await client.getTask("task_test_123")
    expect(task.id).toBe("task_test_123")
    expect(task.state).toBe("done")
    expect(task.result?.outcome).toBe("patch")
  })

  it("gets patch content from remote coding agent", async () => {
    const mockFetch = (async (url: unknown) => {
      expect(String(url)).toBe("https://coding.test.local/api/v1/tasks/task_test_123/patch")
      return new Response("diff --git a/foo b/foo\n+bar", { status: 200, headers: { "Content-Type": "text/plain" } })
    }) as unknown as typeof fetch

    const client = createRemoteClient({
      baseUrl: "https://coding.test.local",
      fetch: mockFetch,
    })

    const patch = await client.getPatch("task_test_123")
    expect(patch).toContain("+bar")
  })

  it("gets patch content from KeptPatchView JSON response", async () => {
    const mockFetch = (async (url: unknown) => {
      expect(String(url)).toBe("https://coding.test.local/api/v1/tasks/task_test_123/patch")
      const json = {
        taskId: "task_test_123",
        kind: "complete",
        untrusted: {
          patch: "diff --git a/foo b/foo\n+untrusted_content",
        },
      }
      return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as unknown as typeof fetch

    const client = createRemoteClient({
      baseUrl: "https://coding.test.local",
      fetch: mockFetch,
    })

    const patch = await client.getPatch("task_test_123")
    expect(patch).toContain("+untrusted_content")
  })

  it("cancels a task via cancel endpoint", async () => {
    const mockFetch = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe("https://coding.test.local/api/v1/tasks/task_test_123/cancel")
      expect(init?.method).toBe("POST")
      return new Response(JSON.stringify({ cancelled: true }), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as unknown as typeof fetch

    const client = createRemoteClient({
      baseUrl: "https://coding.test.local",
      fetch: mockFetch,
    })

    const res = await client.cancelTask("task_test_123")
    expect(res.cancelled).toBe(true)
  })

  it("throws not_found on 404", async () => {
    const mockFetch = (async () => new Response("Not found", { status: 404 })) as unknown as typeof fetch
    const client = createRemoteClient({ baseUrl: "https://coding.test.local", fetch: mockFetch })
    try {
      await client.getTask("missing_task")
      expect.unreachable()
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe("not_found")
    }
  })

  it("throws needs_auth on 401", async () => {
    const mockFetch = (async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch
    const client = createRemoteClient({ baseUrl: "https://coding.test.local", fetch: mockFetch })
    try {
      await client.getTask("task_123")
      expect.unreachable()
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe("needs_auth")
    }
  })
})
