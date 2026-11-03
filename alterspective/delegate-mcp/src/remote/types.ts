// Types for the remote svc-coding-agent workstation delegation client.
export type RemotePublishMode = "github-pr" | "direct-patch"

export type StartRemoteTaskRequest = {
  repo: string
  goal: string
  publishMode?: RemotePublishMode
  seedPatch?: { patch: string }
  agent?: string
  model?: string
  idempotencyKey?: string
}

export type RemoteTaskState =
  | "queued"
  | "awaiting-input"
  | "snapshotting"
  | "provisioning"
  | "engine-running"
  | "stage-starting"
  | "running"
  | "patch-ready"
  | "awaiting-approval"
  | "publishing"
  | "pr-open"
  | "awaiting-merge"
  | "merging"
  | "done"
  | "failed"
  | "cancelled"
  | "rejected"
  | "expired"

export type RemoteTaskResult = {
  outcome?: "pr" | "patch" | "cancelled" | "failed"
  error?: string
  app?: Record<string, unknown>
}

export type RemoteTask = {
  id: string
  repo: string
  goal: string
  state: RemoteTaskState
  publishMode?: RemotePublishMode
  result?: RemoteTaskResult
  createdAt: string
  updatedAt: string
}

export type RemoteTaskSummary = {
  id: string
  repo: string
  state: RemoteTaskState
  goal: string
}

export function toSessionId(taskId: string): string {
  if (taskId.startsWith("ses_")) return taskId
  return `ses_${Buffer.from(taskId, "utf8").toString("hex")}`
}

export function toTaskId(sessionId: string): string {
  if (sessionId.startsWith("ses_")) {
    const hex = sessionId.slice(4)
    if (/^[0-9a-fA-F]+$/.test(hex)) {
      try {
        const decoded = Buffer.from(hex, "hex").toString("utf8")
        if (decoded.startsWith("ct_") || decoded.startsWith("task_")) return decoded
      } catch {
        // fallback
      }
    }
  }
  return sessionId
}
