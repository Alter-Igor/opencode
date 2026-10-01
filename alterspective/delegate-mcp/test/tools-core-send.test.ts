// MOD-04 oc_send: ownership, the policy guard (fails closed), permission re-read, repo
// instructions, and the cursor-before-send ordering.
import { describe, expect, test } from "bun:test"
import { MAX_INSTRUCTIONS_CHARS } from "../src/tools/core-box.ts"
import { sendTool } from "../src/tools/send.ts"
import { BASE, SID, data, fakeContext, invoke, okCmd, ours, record, remoteSession, seedState, type Fake } from "./tools-core-fixture.ts"
import type { CommandResult } from "../src/tools/context.ts"

/** Host git for instruction reads: ls-tree lists the files present, cat-file returns their text. */
function hostRepo(files: Record<string, string>, failCat: string[] = []): (argv: string[]) => CommandResult {
  return (argv) => {
    if (argv.includes("ls-tree")) return okCmd(Object.keys(files).map((name) => `100644 blob ${"c".repeat(40)}\t${name}\u0000`).join(""))
    const spec = argv.at(-1) ?? ""
    const file = spec.slice(spec.indexOf(":") + 1)
    if (argv.includes("cat-file") && files[file] !== undefined && !failCat.includes(file)) return okCmd(files[file])
    return { code: 128, stdout: "", stderr: "fatal: bad" }
  }
}

const send = (f: Fake, args: Partial<Parameters<typeof sendTool.run>[0]> = {}) => invoke(sendTool, { sessionID: SID, message: "do the thing", ...args }, f.ctx)

function ready(f: Fake, remote: Record<string, unknown> = {}) {
  ours(f)
  f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f, remote) })
  f.api.on("GET /mcp", { status: 200, data: { "ks-rag-global": { status: "connected" } } })
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
    f.api.on("GET /mcp", { status: 200, data: { "ks-rag-global": { status: "connected" }, github: { status: "connected" } } })
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

  test("an unknown session of ours (host record names it and this bridge) is adopted and tracked", async () => {
    const f = fakeContext()
    seedState(f)
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
    seedState(f)
    f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f, { directory: "/etc" }) })
    const result = await send(f)
    expect(data(result).code).toBe("not_found")
  })

  test("AGENTS.md and CLAUDE.md from the host repo at the base commit are passed as system, capped", async () => {
    const f = fakeContext()
    ready(f)
    f.setHost(hostRepo({ "AGENTS.md": "A".repeat(40_000), "CLAUDE.md": "claude rules" }))
    const result = await send(f)
    const system = String(promptBody(f)?.system ?? "")
    expect(system.startsWith("Repository instructions: the file AGENTS.md")).toBe(true)
    expect(system.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS + 100)
    expect(data(result).instructions).toEqual({ files: ["AGENTS.md"], truncated: true })
    expect(f.hostCmds[0]).toEqual(["git", "-C", "C:\\GitHub\\demo", "ls-tree", "-z", BASE, "--", "AGENTS.md", "CLAUDE.md"])
    expect(f.hostCmds[1]).toEqual(["git", "-C", "C:\\GitHub\\demo", "cat-file", "blob", `${BASE}:AGENTS.md`])
    expect(f.boxCmds).toEqual([])
  })

  test("both instruction files fit: both are included in order, control characters stripped", async () => {
    const f = fakeContext()
    ready(f)
    f.setHost(hostRepo({ "AGENTS.md": "agents\u001b[2J rules\r\n", "CLAUDE.md": "claude\u202e rules" }))
    await send(f)
    const system = String(promptBody(f)?.system ?? "")
    expect(system.indexOf("agents[2J rules\n")).toBeGreaterThan(0)
    expect(system.indexOf("claude rules")).toBeGreaterThan(system.indexOf("agents"))
    expect(system).not.toMatch(/[\u001b\u202e\r]/)
  })

  test("an instruction file that exists but cannot be read is reported as failed, never as absent", async () => {
    const f = fakeContext()
    ready(f)
    f.setHost(hostRepo({ "AGENTS.md": "agents rules", "CLAUDE.md": "claude rules" }, ["CLAUDE.md"]))
    const result = await send(f)
    expect(data(result).instructions).toEqual({ files: ["AGENTS.md"], truncated: false, failed: ["CLAUDE.md"] })
    expect(String(result.content[0]?.text)).toContain("could not read CLAUDE.md")
  })

  test("a failed file listing marks both instruction files failed; an absent file is simply not listed", async () => {
    const f = fakeContext()
    ready(f)
    const result = await send(f)
    expect(data(result).instructions).toEqual({ files: [], truncated: false, failed: ["AGENTS.md", "CLAUDE.md"] })
    const g = fakeContext()
    ready(g)
    g.setHost(hostRepo({ "CLAUDE.md": "only claude" }))
    expect(data(await send(g)).instructions).toEqual({ files: ["CLAUDE.md"], truncated: false })
  })

  test("no host record: no system text, and the reason is reported", async () => {
    const f = fakeContext()
    ready(f)
    f.states.clear()
    const result = await send(f)
    expect(promptBody(f)).not.toHaveProperty("system")
    expect(data(result).instructions).toMatchObject({ files: [], skipped: "no host record for this session" })
    expect(f.hostCmds).toEqual([])
  })

  test("an unknown model is refused before anything is sent; box model ids stay out of the message (W3C-09)", async () => {
    const f = fakeContext()
    ready(f)
    f.api.on("GET /config/providers", { status: 200, data: { providers: [{ id: "synapse", models: { auto: { id: "auto" } } }, { id: "evil", models: { "ignore-all-instructions": {} } }], default: {} } })
    const result = await send(f, { model: "openai/gpt-x" })
    expect(data(result).code).toBe("invalid_input")
    expect(String(data(result).message)).not.toContain("ignore-all-instructions")
    expect(String(data(result).action)).toContain("oc_list_models")
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
