import { describe, expect, it } from "bun:test"
import { createRuntime } from "../src/runtime.ts"
import { defaultConfig } from "../src/shared/config.ts"
import { createRemoteClient } from "../src/remote/client.ts"
import { doctorTool } from "../src/tools/doctor.ts"
import { startSessionTool, statusTool } from "../src/tools/sessions.ts"
import { resultTool } from "../src/tools/result.ts"
import type { RemoteTask } from "../src/remote/types.ts"

describe("remote delegation runtime", () => {
  it("initializes in remote mode without Docker", async () => {
    const config = {
      ...defaultConfig(),
      backend: "remote" as const,
      remoteUrl: "https://coding.staging.alterspective.com.au",
    }

    const runtime = await createRuntime({ config })
    expect(runtime.ctx.config.backend).toBe("remote")
    expect(runtime.ctx.config.remoteUrl).toBe("https://coding.staging.alterspective.com.au")

    const box = await runtime.ctx.box()
    expect(box.target.baseUrl).toBe("https://coding.staging.alterspective.com.au")
    expect(box.api).toBeDefined()
    expect(box.hub).toBeDefined()

    await runtime.shutdown("test complete")
  })

  it("executes oc_doctor against remote backend", async () => {
    const config = {
      ...defaultConfig(),
      backend: "remote" as const,
      remoteUrl: "https://coding.staging.alterspective.com.au",
    }
    const runtime = await createRuntime({ config })
    const res = await doctorTool.run({}, runtime.ctx, "corr_123")
    expect(res.content.length).toBeGreaterThan(0)
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent?.box).toBeDefined()

    await runtime.shutdown("test complete")
  })

  it("handles start session, status, and result through remote api", async () => {
    const mockTasks = new Map<string, RemoteTask>()

    const mockFetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? "GET"

      if (u.endsWith("/api/v1/tasks") && method === "POST") {
        const body = JSON.parse(String(init?.body))
        const task: RemoteTask = {
          id: "task_rem_1",
          repo: body.repo,
          goal: body.goal,
          state: "done",
          publishMode: body.publishMode ?? "direct-patch",
          result: { outcome: "patch" },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        mockTasks.set(task.id, task)
        return new Response(JSON.stringify(task), { status: 201, headers: { "Content-Type": "application/json" } })
      }

      if (u.includes("/api/v1/tasks/task_rem_1") && method === "GET") {
        const task = mockTasks.get("task_rem_1")!
        return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } })
      }

      return new Response("Not found", { status: 404 })
    }) as unknown as typeof fetch

    const client = createRemoteClient({
      baseUrl: "https://coding.staging.local",
      fetch: mockFetch,
    })

    const task = await client.startTask({
      repo: "Alter-Igor/opencode",
      goal: "implement workstation delegate mode",
      publishMode: "direct-patch",
    })
    expect(task.id).toBe("task_rem_1")
    expect(task.state).toBe("done")

    const fetched = await client.getTask(task.id)
    expect(fetched.result?.outcome).toBe("patch")
  })
})
