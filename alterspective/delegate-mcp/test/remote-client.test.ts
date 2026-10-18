import { describe, expect, it } from "bun:test"
import { createRemoteClient } from "../src/remote/client.ts"
import type { RemoteTask } from "../src/remote/types.ts"

describe("RemoteCodingAgentClient", () => {
  it("calls health endpoint correctly", async () => {
    const mockFetch = (async (url: unknown) => {
      expect(String(url)).toBe("https://coding.test.local/health")
      return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } })
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
    expect(health.error).toContain("connection refused")
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
