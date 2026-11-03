import { describe, expect, it } from "bun:test"
import type { HubEvent } from "../src/shared/contracts.ts"
import { createRemoteOpencodeApi } from "../src/remote/api.ts"
import { createRemoteClient, type RemoteCodingAgentClient } from "../src/remote/client.ts"
import { createRemoteHub } from "../src/remote/hub.ts"
import type { RemoteTask, RemoteTaskState } from "../src/remote/types.ts"

const fixtureFetch = (call: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) =>
  Object.assign(call, { preconnect: () => { throw new Error("Unexpected fixture preconnect") } })

function stubTask(state: RemoteTaskState): RemoteTask {
  return {
    id: "ct_0123456789abcdef",
    repo: "fixture/repo",
    goal: "fixture",
    state,
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z",
  }
}

describe("independent remote adapter containment", () => {
  it("refuses create/send before seed capture or scheduling the title/prompt", async () => {
    const calls = { seed: 0, requests: 0 }
    const client = createRemoteClient({ baseUrl: "https://fixture.invalid", token: "fixture-token", fetch: fixtureFetch(async () => { calls.requests++; return Response.json({ taskId: "ct_fixture" }) }) })
    const api = createRemoteOpencodeApi({ client, getSeedPatch: async () => { calls.seed++; return { repo: "fixture/repo", patch: "fixture" } } })
    for (const input of [
      { path: "/session", body: { title: "TITLE_ONLY", metadata: { sessionKey: "s-1234567890" }, permission: [{ permission: "edit", pattern: "*", action: "deny" }] } },
      { path: "/session/ses_0123456789abcdef/prompt_async", body: { parts: [{ type: "text", text: "REAL_TASK" }], model: { providerID: "synapse", modelID: "auto" }, agent: "opencode" } },
    ]) await expect(api.call({ method: "POST", ...input })).rejects.toMatchObject({ code: "policy_unverified" })
    expect(calls).toEqual({ seed: 0, requests: 0 })
  })

  it("does not fabricate models, MCP entries or unknown successful operations", async () => {
    const client = createRemoteClient({ baseUrl: "https://fixture.invalid", fetch: fixtureFetch(async () => { throw new Error("Unexpected request") }) })
    const api = createRemoteOpencodeApi({ client })
    for (const route of ["/mcp", "/models", "/config/providers", "/config", "/unknown"]) expect(await api.call({ path: route })).toEqual({ status: 501, data: undefined })
  })

  it("transitions to starting on markSent and fires not_started after startWatchdogMs if no running poll arrives (#254)", async () => {
    const sessionID = "ses_0123456789abcdef"
    const client: RemoteCodingAgentClient = {
      health: async () => ({ healthy: true }),
      readiness: async () => { throw new Error("unused") },
      startTask: async () => { throw new Error("unused") },
      getTask: async () => stubTask("done"),
      getPatch: async () => "",
      cancelTask: async () => ({ cancelled: true }),
    }
    const hub = createRemoteHub({ client, startWatchdogMs: 30, pollIntervalMs: 60_000 })
    const observed: HubEvent[] = []
    const unsubscribe = hub.subscribe((ev) => observed.push(ev))
    try {
      const cursor = hub.cursor()
      hub.sendStarting?.(sessionID)
      hub.markSent(sessionID)

      const startingView = await hub.view(sessionID)
      expect(startingView.state).toBe("starting")

      const waitRes = await hub.wait({ sessionIDs: [sessionID], until: ["idle"], timeoutMs: 500, cursor })
      expect(waitRes.timedOut).toBe(false)
      expect(waitRes.events.some((e) => e.state === "not_started" && e.summary === "Turn did not start within 10s")).toBe(true)

      const finalView = await hub.view(sessionID)
      expect(finalView.state).toBe("not_started")
      expect(finalView.detail).toBe("Turn did not start within 10s")
      expect(observed.map((e) => e.state)).toEqual(["starting", "not_started"])
    } finally {
      unsubscribe()
      await hub.stop()
    }
  })

  it("cancels the start watchdog when a running poll state arrives before startWatchdogMs (#254)", async () => {
    const sessionID = "ses_0123456789abcdef"
    let remoteState: RemoteTaskState = "done"
    const client: RemoteCodingAgentClient = {
      health: async () => ({ healthy: true }),
      readiness: async () => { throw new Error("unused") },
      startTask: async () => { throw new Error("unused") },
      getTask: async () => stubTask(remoteState),
      getPatch: async () => "",
      cancelTask: async () => ({ cancelled: true }),
    }
    const hub = createRemoteHub({ client, startWatchdogMs: 60, pollIntervalMs: 15 })
    const observed: HubEvent[] = []
    const unsubscribe = hub.subscribe((ev) => observed.push(ev))
    try {
      hub.sendStarting?.(sessionID)
      hub.markSent(sessionID)
      expect((await hub.view(sessionID)).state).toBe("starting")

      remoteState = "running"
      hub.track(sessionID, "/sessions/s-1234567890")

      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(observed.some((e) => e.state === "busy")).toBe(true)
      expect(observed.some((e) => e.state === "not_started")).toBe(false)
      expect((await hub.view(sessionID)).state).toBe("busy")
    } finally {
      unsubscribe()
      await hub.stop()
    }
  })
})
