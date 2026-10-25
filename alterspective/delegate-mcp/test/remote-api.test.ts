import { describe, expect, it } from "bun:test"
import { createRemoteOpencodeApi } from "../src/remote/api.ts"
import { createRemoteClient } from "../src/remote/client.ts"

const fixtureFetch = (call: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) =>
  Object.assign(call, { preconnect: () => { throw new Error("Unexpected fixture preconnect") } })

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
})
