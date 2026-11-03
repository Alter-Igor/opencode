// Lightweight DelegateHub implementation for remote sessions on svc-coding-agent.
import { randomUUID } from "node:crypto"
import type { Cursor, HubEvent, InboxMessage, SessionState, SessionView } from "../shared/contracts.ts"
import { EventBuffer, viewMatches, type Filter, type Page, type WaitInput, type WaitResult } from "../events/buffer.ts"
import type { DelegateHub, Listener } from "../events/hub.ts"
import { realTimers, type Timers } from "../events/timers.ts"
import type { RemoteCodingAgentClient } from "./client.ts"
import { toTaskId } from "./types.ts"

export type RemoteHubOptions = {
  client: RemoteCodingAgentClient
  pollIntervalMs?: number
  startWatchdogMs?: number
  epoch?: string
  timers?: Timers
}

type TrackedSession = {
  directory: string
  timer?: ReturnType<typeof setInterval>
  lastState?: string
  cachedState?: SessionState
  cachedDetail?: string
  since?: string
  startedSinceSend?: boolean
  watchdogCancel?: () => void
}

const RUNNING_OR_TERMINAL_STATES = new Set<SessionState>(["busy", "retry", "error", "aborted"])

export function createRemoteHub(options: RemoteHubOptions): DelegateHub {
  const epoch = options.epoch ?? randomUUID()
  const timers = options.timers ?? realTimers
  const buffer = new EventBuffer(epoch, timers)
  const tracked = new Map<string, TrackedSession>()
  const listeners = new Set<Listener>()
  const pollIntervalMs = options.pollIntervalMs ?? 1500
  const startWatchdogMs = options.startWatchdogMs ?? 10_000

  function mapState(remoteState: string): SessionState {
    switch (remoteState) {
      case "queued":
      case "snapshotting":
      case "provisioning":
      case "engine-running":
      case "stage-starting":
      case "running":
      case "publishing":
      case "merging":
      case "awaiting-merge":
        return "busy"
      case "awaiting-input":
      case "awaiting-approval":
        return "needs_input"
      case "patch-ready":
      case "pr-open":
      case "done":
        return "idle"
      case "failed":
      case "rejected":
      case "expired":
        return "error"
      case "cancelled":
        return "aborted"
      default:
        return "busy"
    }
  }

  function ensureTracked(sessionID: string, directory = `/remote/${sessionID}`): TrackedSession {
    const existing = tracked.get(sessionID)
    if (existing) return existing
    const info: TrackedSession = { directory }
    tracked.set(sessionID, info)
    return info
  }

  function cancelWatchdog(info: TrackedSession) {
    info.watchdogCancel?.()
    info.watchdogCancel = undefined
  }

  function emit(eventInput: Omit<HubEvent, "cursor" | "at">) {
    const event = buffer.append(eventInput)
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // safe listener execution
      }
    }
    return event
  }

  async function pollSession(sessionID: string) {
    const info = tracked.get(sessionID)
    if (!info) return
    try {
      const task = await options.client.getTask(toTaskId(sessionID))
      if (task.state !== info.lastState) {
        info.lastState = task.state
        const mapped = mapState(task.state)
        if (RUNNING_OR_TERMINAL_STATES.has(mapped)) {
          info.startedSinceSend = true
          cancelWatchdog(info)
        }
        // While awaiting turn start (watchdog armed) and before any running poll was seen,
        // a pre-run idle poll must not clear the starting state or emit a premature idle event.
        if (info.watchdogCancel && !info.startedSinceSend && mapped === "idle") {
          return
        }
        info.cachedState = mapped
        info.cachedDetail = undefined
        info.since = new Date(timers.now()).toISOString()
        emit({
          type: "status",
          sessionID,
          directory: info.directory,
          state: mapped,
          summary: `Remote task ${sessionID} is ${task.state}`,
        })
        if (mapped === "idle" || mapped === "error" || mapped === "aborted") {
          if (info.timer) clearInterval(info.timer)
          info.timer = undefined
        }
      }
    } catch {
      // task polling error
    }
  }

  return {
    async start() {},
    async stop() {
      for (const info of tracked.values()) {
        if (info.timer) clearInterval(info.timer)
        cancelWatchdog(info)
      }
      tracked.clear()
      buffer.close()
    },

    track(sessionID: string, directory: string) {
      const existing = tracked.get(sessionID)
      if (existing?.timer) return
      const timer = setInterval(() => void pollSession(sessionID), pollIntervalMs)
      if (existing) {
        existing.directory = directory
        existing.timer = timer
      } else {
        tracked.set(sessionID, { directory, timer })
      }
      void pollSession(sessionID)
    },

    sendStarting(sessionID: string) {
      const info = ensureTracked(sessionID)
      cancelWatchdog(info)
      info.startedSinceSend = false
    },

    markSent(sessionID: string) {
      const info = ensureTracked(sessionID)
      cancelWatchdog(info)
      if (info.startedSinceSend || (info.cachedState !== undefined && RUNNING_OR_TERMINAL_STATES.has(info.cachedState))) {
        return
      }
      info.cachedState = "starting"
      info.cachedDetail = undefined
      info.since = new Date(timers.now()).toISOString()
      emit({
        type: "status",
        sessionID,
        directory: info.directory,
        state: "starting",
        summary: `Remote task ${sessionID} is starting`,
      })
      info.watchdogCancel = timers.setTimeout(() => {
        info.watchdogCancel = undefined
        if (info.startedSinceSend || (info.cachedState !== "starting" && info.cachedState !== "idle")) {
          return
        }
        info.cachedState = "not_started"
        info.cachedDetail = "Turn did not start within 10s"
        info.since = new Date(timers.now()).toISOString()
        emit({
          type: "status",
          sessionID,
          directory: info.directory,
          state: "not_started",
          summary: "Turn did not start within 10s",
        })
      }, startWatchdogMs)
      if (!info.timer) {
        info.timer = setInterval(() => void pollSession(sessionID), pollIntervalMs)
        void pollSession(sessionID)
      }
    },

    cursor(): Cursor {
      return buffer.head()
    },

    async view(sessionID: string): Promise<SessionView> {
      const info = tracked.get(sessionID)
      if (info?.cachedState === "starting" || info?.cachedState === "not_started") {
        return {
          sessionID,
          state: info.cachedState,
          ...(info.cachedDetail ? { detail: info.cachedDetail } : {}),
          directory: info.directory,
          since: info.since ?? new Date(timers.now()).toISOString(),
        }
      }
      try {
        const task = await options.client.getTask(toTaskId(sessionID))
        return {
          sessionID,
          state: mapState(task.state),
          directory: info?.directory ?? `/remote/${sessionID}`,
          since: task.createdAt,
          observedAt: new Date(timers.now()).toISOString(),
        }
      } catch {
        return {
          sessionID,
          state: "unknown",
          directory: info?.directory ?? `/remote/${sessionID}`,
          since: new Date(timers.now()).toISOString(),
        }
      }
    },

    async wait(input: WaitInput): Promise<WaitResult> {
      if (!input.cursor && input.sessionIDs.length > 0) {
        const currentViews = await Promise.all(input.sessionIDs.map((id) => this.view(id)))
        const matching = currentViews.filter((v) => input.until.some((u) => viewMatches(v, u)))
        if (matching.length > 0) {
          return { events: [], next: buffer.head(), timedOut: false, views: matching }
        }
      }

      const result = await buffer.wait(input)
      const views = input.sessionIDs.length > 0 ? await Promise.all(input.sessionIDs.map((id) => this.view(id))) : undefined
      return {
        ...result,
        ...(views ? { views } : {}),
      }
    },

    events(cursor: Cursor | undefined, filter?: Filter, limit?: number): Page {
      return buffer.page(cursor, filter, limit)
    },

    subscribe(listener: Listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    publishInbox(message: InboxMessage): HubEvent {
      return emit({
        type: "inbox",
        summary: `Inbox message for ${message.to}`,
        untrusted: message.text,
      })
    },
  }
}
