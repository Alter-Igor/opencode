// Types for the remote svc-coding-agent workstation delegation client.
export type RemotePublishMode = "github-pr" | "direct-patch"

export type StartRemoteTaskRequest = {
  repo: string
  goal: string
  publishMode?: RemotePublishMode
  seedPatch?: { patch: string }
  agent?: string
  model?: string
}

export type RemoteTaskState =
  | "queued"
  | "stage-starting"
  | "running"
  | "patch-ready"
  | "publishing"
  | "awaiting-approval"
  | "done"
  | "failed"
  | "cancelled"

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
