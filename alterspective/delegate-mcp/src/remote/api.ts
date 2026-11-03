// Translates OpenCode API calls into svc-coding-agent operations.
import type { Call, OpencodeApi } from "../shared/opencode-api.ts"
import type { RemoteCodingAgentClient } from "./client.ts"
import { DelegateError } from "../shared/errors.ts"
import { toTaskId } from "./types.ts"

export const REMOTE_POLICY_REASON = "Remote execution is blocked: the service cannot represent and verify this bridge's prompt, model and permission contract."

export function refuseRemoteExecution(): never {
  throw new DelegateError("policy_unverified", REMOTE_POLICY_REASON, "Use the local Docker backend. Remote execution needs a separately verified replacement contract (#241).")
}

export type RemoteApiOptions = {
  client: RemoteCodingAgentClient
  getSeedPatch?: (sessionKey: string) => Promise<{ patch?: string; repo: string } | undefined>
}

export function createRemoteOpencodeApi(options: RemoteApiOptions): OpencodeApi {
  const client = options.client

  return {
    async call<T>(input: Call): Promise<{ status: number; data: T | undefined }> {
      const method = input.method ?? "GET"
      const path = input.path

      // POST /session (oc_start_session)
      if (method === "POST" && path === "/session") {
        refuseRemoteExecution()
      }

      // POST /session/:id/prompt_async (oc_send)
      if (method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(path)) {
        refuseRemoteExecution()
      }

      // GET /session/:id (oc_status / oc_wait)
      if (method === "GET" && /^\/session\/[^/]+$/.test(path)) {
        const sessionId = decodeURIComponent(path.split("/")[2] ?? "")
        const taskId = toTaskId(sessionId)
        try {
          const task = await client.getTask(taskId)
          const isBusy = task.state === "queued" || task.state === "running" || task.state === "stage-starting"
          return {
            status: 200,
            data: {
              id: sessionId,
              status: isBusy ? { type: "busy" } : { type: "idle" },
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

      // The service has no equivalent endpoint. Missing evidence is never a fabricated success.
      return { status: 501, data: undefined }
    },
  }
}
