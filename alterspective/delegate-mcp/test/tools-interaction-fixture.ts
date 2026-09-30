// Test helpers for the Wave 3 interaction tools: a scripted OpenCode API that records every call,
// a fake hub, a fake inbox, a ToolContext built from them, and an in-memory MCP client/server pair
// so tools are exercised through the real SDK (zod validation included).
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { z } from "zod"
import type { DelegateHub, Listener } from "../src/events/index.ts"
import { createGuard } from "../src/guard/index.ts"
import type { BridgeInbox, InboxPage } from "../src/inbox/index.ts"
import { defaultConfig } from "../src/shared/config.ts"
import type { Cursor, HubEvent, InboxMessage, Verdict } from "../src/shared/contracts.ts"
import { DelegateError } from "../src/shared/errors.ts"
import { silentLogger } from "../src/shared/log.ts"
import type { Call, OpencodeApi } from "../src/shared/opencode-api.ts"
import type { DelegateSupervisor } from "../src/supervisor/lifecycle.ts"
import type { Box, SessionRecord, ToolContext } from "../src/tools/context.ts"
import { registerTools, type ToolSpec } from "../src/tools/define.ts"

export type Reply = { status: number; data?: unknown }
export type Handler = (call: Call) => Reply | undefined

/** Records calls; the first handler that returns a reply wins; otherwise 404. */
export class ScriptedApi implements OpencodeApi {
  readonly calls: Call[] = []
  readonly handlers: Handler[] = []
  on(handler: Handler): this {
    this.handlers.push(handler)
    return this
  }
  route(method: string, path: string, reply: Reply, directory?: string): this {
    return this.on((c) => ((c.method ?? "GET") === method && c.path === path && (directory === undefined || c.directory === directory) ? reply : undefined))
  }
  async call<T>(input: Call): Promise<{ status: number; data: T | undefined }> {
    this.calls.push(input)
    for (const handler of this.handlers) {
      const reply = handler(input)
      if (reply) return { status: reply.status, data: reply.data as T | undefined }
    }
    return { status: 404, data: undefined }
  }
  posts(): Call[] {
    return this.calls.filter((c) => c.method === "POST")
  }
}

export class FakeHub {
  readonly listeners = new Set<Listener>()
  readonly published: InboxMessage[] = []
  readonly marked: string[] = []
  readonly tracked: string[] = []
  seq = 0
  cursor(): Cursor {
    return { epoch: "e1", seq: this.seq }
  }
  markSent(id: string): void {
    this.marked.push(id)
  }
  track(id: string): void {
    this.tracked.push(id)
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(event: Omit<HubEvent, "cursor" | "at">): void {
    const full: HubEvent = { cursor: { epoch: "e1", seq: ++this.seq }, at: new Date(0).toISOString(), ...event }
    for (const listener of this.listeners) listener(full)
  }
  publishInbox(message: InboxMessage): HubEvent {
    this.published.push(message)
    const event: HubEvent = { cursor: { epoch: "e1", seq: ++this.seq }, at: message.at, type: "inbox", summary: `inbox message ${message.id}`, untrusted: message.text }
    for (const listener of this.listeners) listener(event)
    return event
  }
  asHub(): DelegateHub {
    return this as unknown as DelegateHub
  }
}

export function message(id: string, overrides: Partial<InboxMessage> = {}): InboxMessage {
  return { id, at: new Date().toISOString(), from: "session:ses_abcdefgh1", to: "supervisor:test", text: `text ${id}`, hops: 1, verified: false, ...overrides }
}

export class FakeInbox implements BridgeInbox {
  readonly posts: Array<{ to: string; text: string; correlationId?: string }> = []
  readonly reads: Array<{ cursor?: string; limit?: number }> = []
  /** Scripted read results, used in order; the last one repeats. */
  pages: Array<InboxPage | DelegateError> = [{ messages: [], next: "0000000000000001.0", truncated: false }]
  async post(to: string, text: string, opts: { correlationId?: string } = {}): Promise<InboxMessage> {
    this.posts.push({ to, text, correlationId: opts.correlationId })
    return message(String(this.posts.length), { from: "supervisor:test", to, text, verified: true, correlationId: opts.correlationId })
  }
  async read(cursor?: string, limit?: number): Promise<InboxPage> {
    this.reads.push({ cursor, limit })
    const next = this.pages.length > 1 ? this.pages.shift() : this.pages[0]
    if (!next) throw new Error("no page scripted")
    if (next instanceof DelegateError) throw next
    return next
  }
}

export function record(sessionID: string, boxPath: string): SessionRecord {
  return { sessionID, sessionKey: sessionID.slice(4, 12), hostRepo: "C:\\GitHub\\demo", boxPath, branch: `delegate/${sessionID}`, profile: "standard", createdAt: new Date(0).toISOString() }
}

export type Fixture = {
  ctx: ToolContext
  api: ScriptedApi
  hub: FakeHub
  inbox: FakeInbox
  runtime: { verdict: Verdict; checked: string[] }
  /** peekBox returns the box once `started`; onBox listeners are kept here. */
  boxes: { started: boolean; listeners: Set<(box: Box) => void> }
}

export function fixture(sessions: SessionRecord[] = []): Fixture {
  const api = new ScriptedApi()
  const hub = new FakeHub()
  const inbox = new FakeInbox()
  const runtime: Fixture["runtime"] = { verdict: { ok: true }, checked: [] }
  const boxes: Fixture["boxes"] = { started: false, listeners: new Set() }
  const guard = { ...createGuard(defaultConfig({})), checkRuntime: async (_api: OpencodeApi, directory: string) => (runtime.checked.push(directory), runtime.verdict) }
  let n = 0
  const box: Box = { target: { baseUrl: "http://127.0.0.1:1", password: "unused-in-tests" }, api, hub: hub.asHub() }
  const unused = async (): Promise<never> => {
    throw new Error("unused in these tests")
  }
  const ctx: ToolContext = {
    config: defaultConfig({}),
    supervisor: "supervisor:test",
    bridgeId: "bridge-test",
    version: "0.0.0-test",
    log: silentLogger,
    guard,
    supervisorService: {} as unknown as DelegateSupervisor,
    workspaces: { open: unused, collect: unused, resolveRepo: unused },
    inbox,
    box: async () => box,
    peekBox: () => (boxes.started ? box : undefined),
    apiFor: () => api,
    restartBox: unused,
    onBox: (listener) => {
      boxes.listeners.add(listener)
      return () => boxes.listeners.delete(listener)
    },
    boxExec: unused,
    hostExec: unused,
    sessions: new Map(sessions.map((s) => [s.sessionID, s])),
    correlationId: () => `corr-${++n}`,
  }
  return { ctx, api, hub, inbox, runtime, boxes }
}

export type CallResult = { isError: boolean; text: string; data: Record<string, unknown> }

/** An in-memory MCP client talking to a server with `specs` registered on `ctx`. */
export async function connect(ctx: ToolContext, specs: Array<ToolSpec<z.ZodRawShape>>): Promise<{ call(name: string, args: Record<string, unknown>): Promise<CallResult>; close(): Promise<void> }> {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerTools(server, ctx, specs)
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "test-client", version: "0.0.0" })
  await client.connect(clientSide)
  return {
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args })
      const content = Array.isArray(result.content) ? result.content : []
      const first = content[0] as { text?: unknown } | undefined
      return { isError: result.isError === true, text: typeof first?.text === "string" ? first.text : "", data: (result.structuredContent ?? {}) as Record<string, unknown> }
    },
    async close() {
      await client.close()
      await server.close()
    },
  }
}

/** GET /session/:id for one of our sessions: the baseline rules, so the H3 re-read passes. */
export function sessionRoute(f: Fixture, sessionID: string, directory: string, profile: "standard" | "readonly" = "standard"): void {
  f.api.route("GET", `/session/${sessionID}`, { status: 200, data: { id: sessionID, directory, permission: f.ctx.guard.permissionBaseline(profile) } })
}

export const DIR_A = "/sessions/key-a"
export const SES_A = "ses_aaaaaaaa1"
export const SES_CHILD = "ses_child0001"
export const SES_OTHER = "ses_other0001"
