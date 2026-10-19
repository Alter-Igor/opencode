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
  epoch?: string
  timers?: Timers
}

export function createRemoteHub(options: RemoteHubOptions): DelegateHub {
  const epoch = options.epoch ?? randomUUID()
  const timers = options.timers ?? realTimers
  const buffer = new EventBuffer(epoch, timers)
  const tracked = new Map<string, { directory: string; timer?: ReturnType<typeof setInterval>; lastState?: string }>()
  const listeners = new Set<Listener>()
  const pollIntervalMs = options.pollIntervalMs ?? 1500

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
      }
      tracked.clear()
    },

    track(sessionID: string, directory: string) {
      if (tracked.has(sessionID)) return
      const timer = setInterval(() => void pollSession(sessionID), pollIntervalMs)
      tracked.set(sessionID, { directory, timer })
      void pollSession(sessionID)
    },

    markSent(sessionID: string) {
      // Arms watchdog if desired
    },

    cursor(): Cursor {
      return buffer.head()
    },

    async view(sessionID: string): Promise<SessionView> {
      const info = tracked.get(sessionID)
      try {
        const task = await options.client.getTask(toTaskId(sessionID))
        return {
          sessionID,
          state: mapState(task.state),
          directory: info?.directory ?? `/remote/${sessionID}`,
          since: task.createdAt,
          observedAt: new Date().toISOString(),
        }
      } catch {
        return {
          sessionID,
          state: "unknown",
          directory: info?.directory ?? `/remote/${sessionID}`,
          since: new Date().toISOString(),
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
