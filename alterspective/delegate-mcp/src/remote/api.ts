// Translates OpenCode API calls into svc-coding-agent operations.
import type { Call, OpencodeApi } from "../shared/opencode-api.ts"
import type { RemoteCodingAgentClient } from "./client.ts"
import { toSessionId, toTaskId, type StartRemoteTaskRequest } from "./types.ts"

export type RemoteApiOptions = {
  client: RemoteCodingAgentClient
  getSeedPatch?: (sessionKey: string) => Promise<{ patch?: string; repo: string } | undefined>
}

export function createRemoteOpencodeApi(options: RemoteApiOptions): OpencodeApi {
  const client = options.client
  const activeTasks = new Map<string, { repo: string; goal?: string; agent?: string; model?: string; started: boolean; permission?: unknown }>()

  return {
    async call<T>(input: Call): Promise<{ status: number; data: T | undefined }> {
      const method = input.method ?? "GET"
      const path = input.path

      // POST /session (oc_start_session)
      if (method === "POST" && path === "/session") {
        const body = input.body as { title?: string; permission?: unknown; metadata?: { sessionKey?: string } } | undefined
        const sessionKey = body?.metadata?.sessionKey ?? `rem-${Date.now()}`
        const seed = options.getSeedPatch ? await options.getSeedPatch(sessionKey) : undefined
        const repo = seed?.repo ?? "default/repo"

        // Pre-create task on svc-coding-agent
        const taskReq: StartRemoteTaskRequest = {
          repo,
          goal: body?.title ?? `Delegated session ${sessionKey}`,
          publishMode: "direct-patch",
          ...(seed?.patch ? { seedPatch: { patch: seed.patch } } : {}),
        }
        const task = await client.startTask(taskReq)
        const sessionId = toSessionId(task.id)
        activeTasks.set(sessionId, { repo, goal: taskReq.goal, started: true, permission: body?.permission })
        return { status: 200, data: { id: sessionId } as unknown as T }
      }

      // POST /session/:id/prompt_async (oc_send)
      if (method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(path)) {
        const sessionId = decodeURIComponent(path.split("/")[2] ?? "")
        const taskId = toTaskId(sessionId)
        const body = input.body as { parts?: Array<{ type: string; text: string }>; agent?: string; model?: { id?: string; providerID?: string } } | undefined
        const promptText = body?.parts?.find((p) => p.type === "text")?.text ?? ""
        const existing = activeTasks.get(sessionId)
        if (existing && !existing.started) {
          // Launch task with full prompt as goal if it wasn't launched during POST /session
          await client.startTask({
            repo: existing.repo,
            goal: promptText,
            publishMode: "direct-patch",
            agent: body?.agent ?? existing.agent,
            model: body?.model?.id ? `${body.model.providerID ?? "synapse"}/${body.model.id}` : existing.model,
          })
          existing.started = true
        }
        return { status: 204, data: undefined as unknown as T }
      }

      // GET /session/:id (oc_status / oc_wait)
      if (method === "GET" && /^\/session\/[^/]+$/.test(path)) {
        const sessionId = decodeURIComponent(path.split("/")[2] ?? "")
        const taskId = toTaskId(sessionId)
        try {
          const task = await client.getTask(taskId)
          const isBusy = task.state === "queued" || task.state === "running" || task.state === "stage-starting"
          const existing = activeTasks.get(sessionId)
          return {
            status: 200,
            data: {
              id: sessionId,
              status: isBusy ? { type: "busy" } : { type: "idle" },
              permission: existing?.permission,
            } as unknown as T,
          }
        } catch {
          return { status: 404, data: undefined }
        }
      }

      // GET /session/:id/result (oc_result)
      if (method === "GET" && /^\/session\/[^/]+\/result$/.test(path)) {
        const sessionId = decodeURIComponent(path.split("/")[2] ?? "")
        const taskId = toTaskId(sessionId)
        try {
          const task = await client.getTask(taskId)
          return {
            status: 200,
            data: {
              id: sessionId,
              outcome: task.result?.outcome ?? task.state,
              error: task.result?.error,
              state: task.state,
            } as unknown as T,
          }
        } catch {
          return { status: 404, data: undefined }
        }
      }

      // POST /session/:id/abort (oc_abort)
      if (method === "POST" && /^\/session\/[^/]+\/abort$/.test(path)) {
        const sessionId = decodeURIComponent(path.split("/")[2] ?? "")
        const taskId = toTaskId(sessionId)
        await client.cancelTask(taskId)
        return { status: 200, data: true as unknown as T }
      }

      // GET /models (oc_list_models)
      if (method === "GET" && path === "/models") {
        return {
          status: 200,
          data: [
            { id: "synapse/auto", name: "Synapse Auto Router", provider: "synapse" },
            { id: "synapse/qwen3.8-27b-dflash2", name: "Qwen 3.8 27B DFlash2", provider: "synapse" },
            { id: "synapse/kimi-k2.5", name: "Kimi K2.5", provider: "synapse" },
          ] as unknown as T,
        }
      }

      // GET /mcp (oc_doctor)
      if (method === "GET" && path === "/mcp") {
        return {
          status: 200,
          data: {
            "ks-identity": { status: "connected" },
            "ks-rag-read": { status: "connected" },
          } as unknown as T,
        }
      }

      return { status: 200, data: {} as unknown as T }
    },
  }
}
