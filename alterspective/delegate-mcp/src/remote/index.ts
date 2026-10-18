// Remote delegation module connecting opencode-delegate to svc-coding-agent.
export { createRemoteClient, type RemoteCodingAgentClient, type RemoteClientOptions } from "./client.ts"
export { createRemoteOpencodeApi, type RemoteApiOptions } from "./api.ts"
export { createRemoteHub, type RemoteHubOptions } from "./hub.ts"
export { createRemoteWorkspaces, type RemoteWorkspaces, type RemoteWorkspacesOptions } from "./workspaces.ts"
export { applyRemotePatch, captureSeedPatch, detectRemoteRepo, getHeadCommit, parseGitHubRepo } from "./git.ts"
export type { RemotePublishMode, RemoteTask, RemoteTaskResult, RemoteTaskState, StartRemoteTaskRequest } from "./types.ts"
