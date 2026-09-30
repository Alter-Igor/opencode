// MOD-04 oc_send: ownership, the policy guard (fails closed), permission re-read, repo
// instructions, and the cursor-before-send ordering.
import { describe, expect, test } from "bun:test"
import { MAX_INSTRUCTIONS_CHARS } from "../src/tools/core-box.ts"
import { sendTool } from "../src/tools/send.ts"
import { BASE, SID, data, fakeContext, invoke, okCmd, record, remoteSession, type Fake } from "./tools-core-fixture.ts"

const send = (f: Fake, args: Partial<Parameters<typeof sendTool.run>[0]> = {}) => invoke(sendTool, { sessionID: SID, message: "do the thing", ...args }, f.ctx)

function ready(f: Fake, remote: Record<string, unknown> = {}) {
  f.ctx.sessions.set(SID, record())
  f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f, remote) })
  f.api.on("GET /mcp", { status: 200, data: { "ks-delegate": { status: "connected" } } })
  f.api.on(`POST /session/${SID}/prompt_async`, { status: 204 })
}

const promptBody = (f: Fake) => f.api.find("POST", `/session/${SID}/prompt_async`)?.body as Record<string, unknown> | undefined

describe("oc_send", () => {
  test("reads the cursor before prompt_async and arms markSent after it", async () => {
    const f = fakeContext()
    ready(f)
    const result = await send(f)
    expect(result.isError).toBeUndefined()
    expect(data(result)).toMatchObject({ accepted: true, sessionID: SID, cursor: "ep1.5" })
    const relevant = f.order.filter((o) => o === "cursor" || o === "markSent" || o.includes("prompt_async"))
    expect(relevant).toEqual(["cursor", `POST /session/${SID}/prompt_async`, "markSent"])
  })

  test("never sends the deprecated tools field; sends the text part, model and directory", async () => {
    const f = fakeContext()
    ready(f)
    await send(f, { model: undefined })
    f.ctx.sessions.set(SID, record({ model: "synapse/auto", agent: "build" }))
    await send(f)
    const body = promptBody(f)
    expect(body).not.toHaveProperty("tools")
    expect(body?.parts).toEqual([{ type: "text", text: "do the thing" }])
    const last = f.api.calls.filter((c) => c.path.endsWith("prompt_async")).at(-1)
    expect(last?.body).toMatchObject({ model: { providerID: "synapse", modelID: "auto" }, agent: "build" })
    expect(last?.directory).toBe("/sessions/s-0000000001")
  })

  test("a non-Keystone MCP entry refuses the send with policy_violation and nothing is sent", async () => {
    const f = fakeContext()
    ready(f)
    f.api.on("GET /mcp", { status: 200, data: { "ks-delegate": { status: "connected" }, github: { status: "connected" } } })
    const result = await send(f)
    expect(result.isError).toBe(true)
    expect(data(result).code).toBe("policy_violation")
    expect(f.api.find("POST", `/session/${SID}/prompt_async`)).toBeUndefined()
    expect(f.hub.sent).toEqual([])
    expect(JSON.stringify(result)).not.toContain("github")
  })

  test("an unreadable MCP list refuses with policy_unverified", async () => {
    const f = fakeContext()
    ready(f)
    f.api.on("GET /mcp", { status: 500 })
    const result = await send(f)
    expect(data(result).code).toBe("policy_unverified")
    expect(f.api.find("POST", `/session/${SID}/prompt_async`)).toBeUndefined()
  })

  test("session permission rules that drifted from the baseline refuse the send", async () => {
    const f = fakeContext()
    ready(f, { permission: [{ permission: "*", pattern: "*", action: "allow" }] })
    const result = await send(f)
    expect(data(result).code).toBe("policy_violation")
    expect(f.api.find("POST", `/session/${SID}/prompt_async`)).toBeUndefined()
  })

  test("a foreign session (another bridge's metadata) is refused as not_found", async () => {
    const f = fakeContext()
    f.api.on(`GET /session/${SID}`, { status: 200, data: { ...remoteSession(f), metadata: { supervisor: "supervisor:someone-else", sessionKey: "s-0000000001", hostRepo: "C:\\GitHub\\demo" } } })
    f.api.on("GET /mcp", { status: 200, data: {} })
    const result = await send(f)
    expect(data(result).code).toBe("not_found")
    expect(f.api.find("POST", `/session/${SID}/prompt_async`)).toBeUndefined()
    expect(f.ctx.sessions.has(SID)).toBe(false)
  })

  test("an unknown session of ours (same supervisor in metadata) is adopted and tracked", async () => {
    const f = fakeContext()
    f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f) })
    f.api.on("GET /mcp", { status: 200, data: {} })
    f.api.on(`POST /session/${SID}/prompt_async`, { status: 204 })
    const result = await send(f)
    expect(result.isError).toBeUndefined()
    expect(f.ctx.sessions.get(SID)).toMatchObject({ sessionKey: "s-0000000001", base: BASE, boxPath: "/sessions/s-0000000001" })
    expect(f.hub.tracked).toEqual([[SID, "/sessions/s-0000000001"]])
  })

  test("adoption refuses metadata whose directory does not match its key", async () => {
    const f = fakeContext()
    f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f, { directory: "/etc" }) })
    const result = await send(f)
    expect(data(result).code).toBe("not_found")
  })

  test("AGENTS.md and CLAUDE.md from the host repo at the base commit are passed as system, capped", async () => {
    const f = fakeContext()
    ready(f)
    f.setHost((argv) => (argv.at(-1) === `${BASE}:AGENTS.md` ? okCmd("A".repeat(40_000)) : argv.at(-1) === `${BASE}:CLAUDE.md` ? okCmd("claude rules") : { code: 128, stdout: "", stderr: "" }))
    const result = await send(f)
    const system = String(promptBody(f)?.system ?? "")
    expect(system.startsWith("Repository instructions: the file AGENTS.md")).toBe(true)
    expect(system.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS + 100)
    expect(data(result).instructions).toEqual({ files: ["AGENTS.md"], truncated: true })
    expect(f.hostCmds[0]).toEqual(["git", "-C", "C:\\GitHub\\demo", "show", `${BASE}:AGENTS.md`])
    expect(f.boxCmds).toEqual([])
  })

  test("both instruction files fit: both are included in order", async () => {
    const f = fakeContext()
    ready(f)
    f.setHost((argv) => okCmd(argv.at(-1)?.endsWith("AGENTS.md") ? "agents rules" : "claude rules"))
    await send(f)
    const system = String(promptBody(f)?.system ?? "")
    expect(system.indexOf("agents rules")).toBeGreaterThan(0)
    expect(system.indexOf("claude rules")).toBeGreaterThan(system.indexOf("agents rules"))
  })

  test("no base commit: no system text, and the reason is reported", async () => {
    const f = fakeContext()
    ready(f)
    f.ctx.sessions.set(SID, record({ base: undefined }))
    const result = await send(f)
    expect(promptBody(f)).not.toHaveProperty("system")
    expect(data(result).instructions).toMatchObject({ files: [], skipped: "no recorded base commit" })
  })

  test("an unknown model is refused with the list, before anything is sent", async () => {
    const f = fakeContext()
    ready(f)
    f.api.on("GET /config/providers", { status: 200, data: { providers: [{ id: "synapse", models: { auto: { id: "auto" } } }], default: {} } })
    const result = await send(f, { model: "openai/gpt-x" })
    expect(data(result).code).toBe("invalid_input")
    expect(String(data(result).message)).toContain("synapse/auto")
    expect(f.api.find("POST", `/session/${SID}/prompt_async`)).toBeUndefined()
  })

  test("a failed prompt_async is upstream_error and does not arm the watchdog", async () => {
    const f = fakeContext()
    ready(f)
    f.api.on(`POST /session/${SID}/prompt_async`, { status: 400 })
    const result = await send(f)
    expect(data(result).code).toBe("upstream_error")
    expect(f.hub.sent).toEqual([])
  })

  test("an invalid session id is invalid_input", async () => {
    const f = fakeContext()
    await expect(sendTool.run({ sessionID: "../etc", message: "x" }, f.ctx, "c")).rejects.toMatchObject({ code: "invalid_input" })
  })
})
