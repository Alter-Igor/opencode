// MOD-04: the MCP server in-process over the SDK's in-memory transport, as a client sees it.
import { afterEach, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CHANNEL_INSTRUCTIONS } from "../src/channels.ts"
import { createServer, SERVER_NAME, type DelegateServer } from "../src/server.ts"
import { fakeContext, TARGET, type Fake } from "./tools-core-fixture.ts"

const CORE = [
  "oc_abort", "oc_collect", "oc_doctor", "oc_events", "oc_list_models", "oc_list_sessions", "oc_login",
  "oc_result", "oc_send", "oc_server_restart", "oc_start_session", "oc_status", "oc_wait",
]

let open: Array<{ client: Client; server: DelegateServer }> = []

async function connect(f: Fake, channels = false) {
  const server = createServer(f.ctx, { channels })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await server.server.connect(serverSide)
  await client.connect(clientSide)
  open.push({ client, server })
  return client
}

afterEach(async () => {
  for (const { client, server } of open) {
    await client.close()
    await server.close()
  }
  open = []
})

describe("MCP server", () => {
  test("identifies itself with the bridge version and lists the core tools with schemas", async () => {
    const f = fakeContext()
    const client = await connect(f)
    expect(client.getServerVersion()).toMatchObject({ name: SERVER_NAME, version: "0.1.0-dev+abc1234" })
    expect(client.getInstructions()).toContain("untrusted")
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    for (const name of CORE) expect(names).toContain(name)
    const send = tools.find((t) => t.name === "oc_send")
    expect(send?.inputSchema.required).toEqual(["sessionID", "message"])
    expect(Object.keys(send?.inputSchema.properties ?? {})).toEqual(["sessionID", "message", "model", "agent", "correlationId"])
    const wait = tools.find((t) => t.name === "oc_wait")
    expect(wait?.inputSchema.properties?.timeoutSec).toMatchObject({ type: "integer", maximum: 240 })
    expect(tools.find((t) => t.name === "oc_doctor")?.annotations).toMatchObject({ readOnlyHint: true })
    expect(tools.find((t) => t.name === "oc_server_restart")?.annotations).toMatchObject({ destructiveHint: true })
  })

  test("oc_doctor over MCP returns structured, secret-free JSON without starting the box", async () => {
    const f = fakeContext({ boxHeld: false })
    f.api.on("GET /mcp", { status: 200, data: { "ks-delegate": { status: "needs_auth" } } })
    const client = await connect(f)
    const result = await client.callTool({ name: "oc_doctor", arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ isolation: "S", mcp: { entries: [{ name: "ks-delegate", status: "needs_auth" }] }, guard: { ok: true } })
    expect(JSON.stringify(result)).not.toContain(TARGET.password)
    expect(f.started.count).toBe(0)
  })

  test("invalid input is rejected by the schema and a tool error comes back as {code,message,action}", async () => {
    const f = fakeContext()
    const client = await connect(f)
    const bad = await client.callTool({ name: "oc_send", arguments: { sessionID: "nope", message: "x" } })
    expect(bad.isError).toBe(true)
    const refused = await client.callTool({ name: "oc_server_restart", arguments: { confirm: false } })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({ code: "invalid_input" })
    expect(f.started.restarts).toBe(0)
  })

  test("with channels: capability + channel instructions declared, interaction attached once a box exists", async () => {
    const f = fakeContext({ boxHeld: false })
    const listeners: Array<(box: typeof f.box) => void> = []
    f.ctx.onBox = (listener) => {
      listeners.push(listener)
      return () => {}
    }
    const client = await connect(f, true)
    expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} })
    expect(client.getInstructions()).toContain(CHANNEL_INSTRUCTIONS)
    expect(listeners).toHaveLength(1)
    expect(() => listeners[0]?.(f.box)).not.toThrow()
  })

  test("without channels: no channel capability, but the inbox poller still follows the box", async () => {
    const f = fakeContext({ boxHeld: false })
    let subscribed = 0
    f.ctx.onBox = () => (subscribed++, () => {})
    const client = await connect(f)
    expect(client.getServerCapabilities()?.experimental).toBeUndefined()
    expect(client.getInstructions()).not.toContain(CHANNEL_INSTRUCTIONS)
    expect(subscribed).toBe(1)
  })
})
