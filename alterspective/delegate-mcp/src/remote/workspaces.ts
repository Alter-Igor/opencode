// Remote implementation of DelegateWorkspaces talking to svc-coding-agent.
import path from "node:path"
import type { BridgeConfig } from "../shared/config.ts"
import type { Workspace } from "../shared/contracts.ts"
import type { Logger } from "../shared/log.ts"
import { safeLog, silentLogger } from "../shared/log.ts"
import { canonicalPath, systemSubst } from "../supervisor/workspaces-exec.ts"
import { bindHostState, listHostStates, readHostState, removeHostState, updateHostState, writeHostState, type HostSessionState, type SessionBinding } from "../supervisor/workspaces-state.ts"
import { closeCandidates, type CandidateOptions, type CloseCandidates, type CloseHooks, type CloseOptions, type CloseOutcome, type CloseOwner, type ClosePlan } from "../supervisor/workspaces-close.ts"
import type { DelegateWorkspaces, OpenedWorkspace } from "../supervisor/workspaces.ts"
import type { RemoteCodingAgentClient } from "./client.ts"
import { applyRemotePatch, captureSeedPatch, detectRemoteRepo, getHeadCommit } from "./git.ts"
import { toTaskId } from "./types.ts"

export type RemoteWorkspacesOptions = {
  config: BridgeConfig
  client: RemoteCodingAgentClient
  stateDir?: string
  logger?: Logger
}

export type RemoteWorkspaces = DelegateWorkspaces & {
  getSeedPatch(sessionKey: string): Promise<{ patch?: string; repo: string } | undefined>
}

export function createRemoteWorkspaces(options: RemoteWorkspacesOptions): RemoteWorkspaces {
  const config = options.config
  const client = options.client
  const stateDir = options.stateDir ?? path.join(config.home, "workspaces")
  const logger = options.logger ?? silentLogger
  const seedPatches = new Map<string, { patch?: string; repo: string }>()

  async function resolveRepo(hostRepo: string): Promise<string> {
    const subst = await systemSubst()
    return canonicalPath(hostRepo, subst, config.roots)
  }

  return {
    async getSeedPatch(sessionKey: string) {
      return seedPatches.get(sessionKey)
    },

    async open(hostRepo: string, sessionKey: string): Promise<OpenedWorkspace> {
      safeLog(logger, "info", "remote-workspaces", "open called", { sessionKey })
      const repo = await resolveRepo(hostRepo)
      const { patch, headSha } = await captureSeedPatch(repo)
      const remoteRepo = await detectRemoteRepo(repo)

      seedPatches.set(sessionKey, { patch, repo: remoteRepo })
      writeHostState(stateDir, {
        sessionKey,
        hostRepo: repo,
        base: headSha,
        createdAt: new Date().toISOString(),
      })

      const branch = `delegate/${sessionKey}`
      const ws: OpenedWorkspace = {
        sessionKey,
        hostRepo: repo,
        boxPath: `/remote/${sessionKey}`,
        branch,
        base: headSha,
      }
      safeLog(logger, "info", "remote-workspaces", "open done", { sessionKey, branch, base: headSha })
      return ws
    },

    async collect(ws: Workspace) {
      safeLog(logger, "info", "remote-workspaces", "collect called", { sessionKey: ws.sessionKey })
      const state = readHostState(stateDir, ws.sessionKey)
      const sessionId = state?.sessionID
      if (!sessionId) {
        throw new Error(`Session ${ws.sessionKey} has no remote task ID bound.`)
      }

      const patch = await client.getPatch(toTaskId(sessionId))
      const base = state.base ?? (await getHeadCommit(ws.hostRepo))
      const { filesChanged } = await applyRemotePatch(ws.hostRepo, ws.branch, base, patch)

      safeLog(logger, "info", "remote-workspaces", "collect done", { sessionKey: ws.sessionKey, filesChanged: filesChanged.length })
      return {
        branch: ws.branch,
        commits: filesChanged.length > 0 ? 1 : 0,
        hostExecutableChanges: [],
        mirrorAddressFiles: [],
      }
    },

    async sync(ws: Workspace, ref: string) {
      return { synced: true, head: ref, commitsSynced: 0 }
    },

    resolveRepo,

    async bindSession(key: string, binding: SessionBinding) {
      return bindHostState(stateDir, key, { ...binding, boxProject: config.project })
    },

    async updateSessionState(key: string, patch: Partial<HostSessionState>) {
      return updateHostState(stateDir, key, patch)
    },

    async sessionState(key: string) {
      return readHostState(stateDir, key)
    },

    async listSessionStates() {
      return listHostStates(stateDir)
    },

    async pruneSessionStates() {
      return []
    },

    async discard(key: string) {
      seedPatches.delete(key)
      removeHostState(stateDir, key)
    },

    async inspectClose(key: string, owner: CloseOwner, closeOptions: Pick<CloseOptions, "deleteBranch">): Promise<ClosePlan> {
      const state = readHostState(stateDir, key)
      return {
        sessionKey: key,
        sessionID: state?.sessionID ?? "unknown",
        clone: "absent",
        safe: true,
        uncollectedCommits: 0,
        discardedCommits: 0,
        uncommittedPaths: 0,
        ignoredPaths: 0,
        ignoredExamples: [],
        branch: closeOptions.deleteBranch ? "merged" : "not_requested",
      }
    },

    async closeSession(key: string, owner: CloseOwner, closeOptions: CloseOptions, hooks: CloseHooks): Promise<CloseOutcome> {
      const state = readHostState(stateDir, key)
      seedPatches.delete(key)
      removeHostState(stateDir, key)
      return {
        closed: true,
        sessionKey: key,
        sessionID: state?.sessionID ?? "unknown",
        session: "deleted",
        clone: "removed",
        branch: closeOptions.deleteBranch ? "deleted" : "not_requested",
        record: "removed",
        uncollectedCommits: 0,
        discardedCommits: 0,
        uncommittedPaths: 0,
        ignoredPaths: 0,
        ignoredExamples: [],
      }
    },

    async closeCandidates(supervisor: string, before: Date, limit: number, candidateOptions?: CandidateOptions): Promise<CloseCandidates> {
      return closeCandidates({ stateDir, boxProject: config.project }, supervisor, before, limit, candidateOptions)
    },
  }
}
