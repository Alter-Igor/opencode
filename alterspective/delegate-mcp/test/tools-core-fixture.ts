// Test helpers for the MOD-04 core tools: a fake ToolContext with a recording fake API, a fake
// event hub and fake workspaces / command runners. No Docker, no network.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { frontServersFor } from "../src/guard/egress.ts"
import { createGuard } from "../src/guard/index.ts"
import { defaultConfig } from "../src/shared/config.ts"
import type { Cursor, HubEvent, SessionView, WaitUntil } from "../src/shared/contracts.ts"
import { silentLogger } from "../src/shared/log.ts"
import type { ApiTarget, Call, OpencodeApi } from "../src/shared/opencode-api.ts"
import type { DelegateHub } from "../src/events/index.ts"
import type { LiveChecks } from "../src/supervisor/live.ts"
import type { SupervisorStatus } from "../src/supervisor/status.ts"
import type { HostSessionState } from "../src/supervisor/workspaces-state.ts"
import type { Box, CommandResult, SessionRecord, ToolContext } from "../src/tools/context.ts"
import type { ToolSpec } from "../src/tools/define.ts"
import { fail, type ToolResult } from "../src/tools/shape.ts"
import { fakeSynapse } from "./synapse-fixture.ts"
import type { z } from "zod"

/**
 * A throw-away bridge home with no saved Keystone choice: the set is read from <home>/keystone.json,
 * never the owner's real one. A test that saves a choice gives its context its own home.
 */
export const FIXTURE_HOME = mkdtempSync(path.join(os.tmpdir(), "ocd-tools-"))
// As after a start: front's servers file generated for the default set (oc_doctor's egress check reads it).
mkdirSync(path.join(FIXTURE_HOME, "front"))
writeFileSync(path.join(FIXTURE_HOME, "front", "servers.conf"), frontServersFor(defaultConfig({})))

export const SID = "ses_0123456789abcdefAB"
export const OTHER_SID = "ses_ffffffffffffffffFF"
export const BASE = "a".repeat(40)
export const TARGET: ApiTarget = { baseUrl: "http://127.0.0.1:45678", password: "secret-password-XYZ123" }

export type Reply = { status: number; data?: unknown } | Error
export type Recorded = { method: string; path: string; directory?: string; body?: unknown; correlationId?: string; timeoutMs?: number }

export class FakeApi implements OpencodeApi {
  readonly calls: Recorded[] = []
  readonly routes = new Map<string, Reply>()
  constructor(private readonly order: string[]) {}

  /** Route by "METHOD /path" (query string included). */
  on(key: string, reply: Reply): this {
    this.routes.set(key, reply)
    return this
  }

  async call<T>(input: Call) {
    const method = input.method ?? "GET"
    this.calls.push({ method, path: input.path, directory: input.directory, body: input.body, correlationId: input.correlationId, timeoutMs: input.timeoutMs })
    this.order.push(`${method} ${input.path}`)
    const reply = this.routes.get(`${method} ${input.path}`) ?? { status: 404 }
    if (reply instanceof Error) throw reply
    return { status: reply.status, data: reply.data as T | undefined }
  }

  find(method: string, path: string): Recorded | undefined {
    return this.calls.find((c) => c.method === method && c.path === path)
  }
}

export type WaitCall = { sessionIDs: string[]; until: WaitUntil[]; timeoutMs: number; cursor?: Cursor }

export class FakeHub implements DelegateHub {
  readonly tracked: Array<[string, string]> = []
  readonly sent: string[] = []
  readonly waits: WaitCall[] = []
  readonly views = new Map<string, SessionView>()
  waitResult: Awaited<ReturnType<DelegateHub["wait"]>> = { events: [], next: { epoch: "ep1", seq: 9 }, timedOut: false }
  buffered: HubEvent[] = []
  seq = 5
  stopped = 0
  constructor(private readonly order: string[]) {}
  async start() {}
  async stop() {
    this.stopped++
  }
  track(sessionID: string, directory: string) {
    this.tracked.push([sessionID, directory])
  }
  markSent(sessionID: string) {
    this.order.push("markSent")
    this.sent.push(sessionID)
  }
  cursor(): Cursor {
    this.order.push("cursor")
    return { epoch: "ep1", seq: this.seq }
  }
  async view(sessionID: string): Promise<SessionView> {
    return this.views.get(sessionID) ?? { sessionID, directory: "/sessions/s-0000000001", state: "idle", since: "2026-10-01T00:00:00.000Z" }
  }
  events(cursor: Cursor | undefined, filter?: { sessionID?: string }, limit = 50) {
    const events = this.buffered.filter((e) => (!cursor || e.cursor.seq > cursor.seq) && (!filter?.sessionID || e.sessionID === filter.sessionID)).slice(0, limit)
    return { events, next: events[events.length - 1]?.cursor ?? cursor ?? { epoch: "ep1", seq: 0 }, expired: cursor !== undefined && cursor.epoch !== "ep1" }
  }
  async wait(input: WaitCall) {
    this.waits.push(input)
    return this.waitResult
  }
  subscribe() {
    return () => {}
  }
  publishInbox(): HubEvent {
    throw new Error("not used")
  }
}

export type Fake = {
  ctx: ToolContext
  api: FakeApi
  hub: FakeHub
  order: string[]
  box: Box
  boxCmds: string[][]
  hostCmds: string[][]
  opened: Array<[string, string]>
  collected: string[]
  /** Host-only session records (workspaces-state.ts), by session key. */
  states: Map<string, HostSessionState>
  discarded: string[]
  started: { count: number; restarts: number }
  /** oc_server_restart: the force option of each restartBox call, and what the next one reports as interrupted. */
  restart: { forced: boolean[]; interrupted: number }
  setHost(fn: (argv: string[]) => CommandResult): void
  setBox(fn: (argv: string[]) => CommandResult): void
  status: { value: SupervisorStatus }
  /** What supervisor.verifyLive() reports (R5-01, R5-05); all checks pass by default. */
  live: { value: LiveChecks }
}

export const LIVE_OK: LiveChecks = {
  ok: true,
  signIns: { ok: true, names: ["ks-rag-read", "ks-github", "ks-seqlogs"], stale: [], unrecognised: 0, removedBefore: [] },
  front: { ok: true, loadedConfigMatches: true, mountReadOnly: true, boxMountsOk: true, problems: [] },
  problems: [],
}

export const okCmd = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" })

export function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { sessionID: SID, sessionKey: "s-0000000001", hostRepo: "C:\\GitHub\\demo", boxPath: "/sessions/s-0000000001", branch: "delegate/s-0000000001", profile: "standard", createdAt: "2026-10-01T00:00:00.000Z", base: BASE, ...overrides }
}

function fakeServices(f: Fake): Pick<ToolContext, "supervisorService" | "workspaces"> {
  return {
    supervisorService: {
      ensure: async () => TARGET,
      status: async () => f.status.value,
      verifyLive: async () => f.live.value,
      release: async () => {},
      replace: async () => ({ target: TARGET, interrupted: f.restart.interrupted, keystone: [] }),
      login: async () => "connected",
    },
    workspaces: {
      resolveRepo: async (dir) => dir,
      open: async (hostRepo, key) => {
        f.opened.push([hostRepo, key])
        f.states.set(key, { sessionKey: key, hostRepo, base: BASE, createdAt: "2026-10-01T00:00:00.000Z" })
        return { sessionKey: key, hostRepo, boxPath: `/sessions/${key}`, branch: `delegate/${key}`, base: BASE }
      },
      collect: async (ws) => {
        f.collected.push(ws.sessionKey)
        return { branch: ws.branch, commits: 1, hostExecutableChanges: [] }
      },
      bindSession: async (key, binding) => {
        const current = f.states.get(key)
        if (!current) throw new Error(`no state for ${key}`)
        const next = { ...current, ...binding }
        f.states.set(key, next)
        return next
      },
      sessionState: async (key) => f.states.get(key),
      listSessionStates: async () => [...f.states.values()],
      pruneSessionStates: async () => [],
      discard: async (key) => {
        f.discarded.push(key)
        f.states.delete(key)
      },
      // #72: tests of oc_close_session / oc_cleanup use the real workspaces (tools-close.test.ts).
      inspectClose: async () => {
        throw new Error("not used: tools-close.test.ts uses real workspaces")
      },
      closeSession: async () => {
        throw new Error("not used: tools-close.test.ts uses real workspaces")
      },
      closeCandidates: async () => ({ states: [], legacy: 0, otherBox: 0, otherBridge: 0 }),
    },
  }
}

export function fakeContext(options: { boxHeld?: boolean } = {}): Fake {
  const order: string[] = []
  const api = new FakeApi(order)
  const hub = new FakeHub(order)
  const box: Box = { target: TARGET, api, hub }
  const config = { ...defaultConfig({}), roots: ["C:\\GitHub"], home: FIXTURE_HOME }
  let held = options.boxHeld !== false
  let host = (_argv: string[]) => ({ code: 128, stdout: "", stderr: "fatal: path not in tree" }) as CommandResult
  let inBox = (argv: string[]) => (argv.includes("rev-parse") ? okCmd(`${BASE}\n`) : okCmd(""))
  const f: Fake = {
    api, hub, order, box, boxCmds: [], hostCmds: [], opened: [], collected: [], states: new Map(), discarded: [], started: { count: 0, restarts: 0 }, restart: { forced: [], interrupted: 0 },
    setHost: (fn) => (host = fn),
    setBox: (fn) => (inBox = fn),
    status: { value: { state: "running", target: TARGET, imageTag: "img:1", startedBy: "other", health: "healthy", policyVerified: true, frontMatches: true, imageMatches: true } },
    live: { value: LIVE_OK },
    ctx: undefined as unknown as ToolContext,
  }
  f.ctx = {
    config,
    supervisor: "supervisor:test-bridge",
    bridgeId: "test-bridge-1",
    version: "0.1.0-dev+abc1234",
    log: silentLogger,
    guard: createGuard(config),
    ...fakeServices(f),
    synapse: fakeSynapse(),
    inbox: { post: async () => { throw new Error("not used") }, read: async () => { throw new Error("not used") } } as unknown as ToolContext["inbox"],
    box: async () => {
      f.started.count++
      held = true
      return box
    },
    peekBox: () => (held ? box : undefined),
    apiFor: () => api,
    restartBox: async (options) => {
      f.started.restarts++
      f.restart.forced.push(options?.force === true)
      return { ...box, interrupted: f.restart.interrupted, keystone: options?.keystone ?? [] }
    },
    onBox: () => () => {},
    boxExec: async (argv) => {
      f.boxCmds.push(argv)
      return inBox(argv)
    },
    hostExec: async (argv) => {
      f.hostCmds.push(argv)
      return host(argv)
    },
    sessions: new Map(),
    correlationId: () => "cid-test",
  }
  return f
}

/** The host record that makes `rec` (default: record()) a session of this bridge. */
export function seedState(f: Fake, overrides: Partial<HostSessionState> = {}, rec: SessionRecord = record()): HostSessionState {
  const state: HostSessionState = { sessionKey: rec.sessionKey, hostRepo: rec.hostRepo, base: rec.base ?? BASE, createdAt: rec.createdAt, sessionID: rec.sessionID, supervisor: f.ctx.supervisor, profile: rec.profile, ...overrides }
  f.states.set(state.sessionKey, state)
  return state
}

/** A session this process tracks AND has a host record for (the normal case after oc_start_session). */
export function ours(f: Fake, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const rec = record(overrides)
  f.ctx.sessions.set(rec.sessionID, rec)
  seedState(f, {}, rec)
  return rec
}

/** The remote session the fake API returns for GET /session/:id. */
export function remoteSession(f: Fake, overrides: Record<string, unknown> = {}, profile: "standard" | "readonly" = "standard") {
  return {
    id: SID,
    directory: "/sessions/s-0000000001",
    title: "t",
    metadata: { supervisor: f.ctx.supervisor, sessionKey: "s-0000000001", hostRepo: "C:\\GitHub\\demo", base: BASE, profile },
    permission: f.ctx.guard.permissionBaseline(profile),
    ...overrides,
  }
}

export function data(result: ToolResult): Record<string, unknown> {
  return result.structuredContent ?? {}
}

export function text(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n")
}

/** Run a tool the way registerTools does: a thrown error becomes a fail() result. */
export async function invoke<S extends z.ZodRawShape>(spec: ToolSpec<S>, args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolResult> {
  try {
    return await spec.run(args, ctx, "cid-test")
  } catch (error) {
    return fail(error)
  }
}
