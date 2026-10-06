// #73 delegate reporting through the tool layer: every task gets one host-side record that
// oc_start_session, oc_send, oc_wait, oc_result, oc_collect and oc_close_session keep current, and
// oc_report summarises. A record failure never fails the tool, and no prompt text is ever stored.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { shutdownOnce } from "../src/runtime.ts"
import { silentLogger } from "../src/shared/log.ts"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { flushReports, reportsDir } from "../src/reporting/hooks.ts"
import type { TaskRecord } from "../src/reporting/record.ts"
import type { CloseOutcome } from "../src/supervisor/workspaces.ts"
import { cleanupTool, closeSessionTool } from "../src/tools/close-session.ts"
import { collectTool } from "../src/tools/collect.ts"
import { allTools } from "../src/tools/index.ts"
import { reportTool } from "../src/tools/report.ts"
import { resultTool } from "../src/tools/result.ts"
import { sendTool } from "../src/tools/send.ts"
import { startSessionTool } from "../src/tools/sessions.ts"
import { waitTool } from "../src/tools/wait.ts"
import { SID, data, fakeContext, invoke as invokeNow, remoteSession, text, type Fake } from "./tools-core-fixture.ts"

const MARKER = "PROMPT-MARKER-7f3a9c-client-confidential"

/** Review cycle 2: hooks never make a tool wait, so a test waits for the background record updates. */
const invoke: typeof invokeNow = async (spec, args, ctx) => {
  const result = await invokeNow(spec, args, ctx)
  await flushReports()
  return result
}

/** A fake context with its own bridge home, so its report folder holds only this test's records. */
function context(): Fake {
  const f = fakeContext()
  const home = mkdtempSync(path.join(os.tmpdir(), "ocd-rtools-"))
  f.ctx.config = { ...f.ctx.config, home }
  f.api.on("POST /session", { status: 200, data: { id: SID } })
  f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "connected" } } })
  f.api.on(`POST /session/${SID}/prompt_async`, { status: 204 })
  f.api.on("GET /config", { status: 200, data: { model: "synapse/auto" } })
  f.api.on("GET /config/providers", { status: 200, data: { providers: [{ id: "synapse", models: { auto: { id: "auto" } } }] } })
  return f
}

async function started(f: Fake): Promise<string> {
  const result = await invoke(startSessionTool, { directory: "C:\\GitHub\\demo-repo" }, f.ctx)
  expect(result.isError).toBeUndefined()
  const key = String(data(result).sessionKey)
  f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f, { directory: `/sessions/${key}`, metadata: { supervisor: f.ctx.supervisor, sessionKey: key } }) })
  return key
}

const dir = (f: Fake) => reportsDir(f.ctx.config)
const stored = (f: Fake, key: string): TaskRecord => JSON.parse(readFileSync(path.join(dir(f), `${key}.json`), "utf8")) as TaskRecord
const settle = (f: Fake, state: "idle" | "error" | "aborted", key: string, lastError?: string) => {
  f.hub.waitResult = { events: [], next: { epoch: "ep1", seq: 12 }, timedOut: false, views: [{ sessionID: SID, directory: `/sessions/${key}`, state, since: new Date().toISOString(), ...(lastError ? { lastError } : {}) }] }
}
const assistant = (providerID: string, modelID: string, tokens: Record<string, unknown>) => ({
  info: { id: "msg_a1", role: "assistant", providerID, modelID, tokens },
  parts: [{ type: "text", text: `answer mentioning ${MARKER}` }],
})

function closeWith(f: Fake, outcome: Partial<CloseOutcome>) {
  f.ctx.workspaces.closeSession = async (key, owner, _options, hooks) => {
    await hooks.stop()
    const session = await hooks.deleteSession()
    return { sessionKey: key, sessionID: owner.sessionID, closed: true, session, clone: "removed", branch: "not_requested", record: "removed", uncollectedCommits: 0, discardedCommits: 0, uncommittedPaths: 0, ignoredPaths: 0, ignoredExamples: [], ...outcome }
  }
}

describe("task records across the session lifecycle", () => {
  test("start -> send -> wait -> result -> collect -> close keeps one record current", async () => {
    const f = context()
    const key = await started(f)
    let r = stored(f, key)
    expect(r).toMatchObject({ sessionID: SID, key, bridge: "test-bridge", caller: "test-caller", repo: "demo-repo", sendCount: 0, outcome: "unknown", collected: false, disposition: "open" })
    expect(JSON.stringify(r)).not.toContain("C:\\\\GitHub")

    expect((await invoke(sendTool, { sessionID: SID, message: "first", model: "synapse/auto" }, f.ctx)).isError).toBeUndefined()
    r = stored(f, key)
    expect(r).toMatchObject({ sendCount: 1, requestedModel: "synapse/auto", outcome: "running" })
    expect(r.lastSendAt).toBeDefined()

    settle(f, "idle", key)
    expect((await invoke(waitTool, { sessionIDs: [SID] }, f.ctx)).isError).toBeUndefined()
    r = stored(f, key)
    expect(r.outcome).toBe("completed")
    expect(r.finishedAt).toBeDefined()
    expect(typeof r.durationMs).toBe("number")

    f.api.on(`GET /session/${SID}/message?limit=8`, { status: 200, data: [
      { info: { id: "msg_u1", role: "user" }, parts: [{ type: "text", text: MARKER }] },
      assistant("synapse", "qwen-coder", { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 1 } }),
      assistant("synapse", "qwen-coder", { input: 50, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }),
    ] })
    expect((await invoke(resultTool, { sessionID: SID }, f.ctx)).isError).toBeUndefined()
    r = stored(f, key)
    expect(r).not.toHaveProperty("servedModel")
    expect(r.tokens).toEqual({ input: 150, output: 30, reasoning: 5, cacheRead: 7, cacheWrite: 1 })

    expect((await invoke(collectTool, { sessionID: SID }, f.ctx)).isError).toBeUndefined()
    r = stored(f, key)
    expect(r).toMatchObject({ commitsCollected: 1, collected: true, disposition: "collected" })

    f.api.on(`DELETE /session/${SID}`, { status: 200, data: true })
    closeWith(f, {})
    expect((await invoke(closeSessionTool, { sessionID: SID }, f.ctx)).isError).toBeUndefined()
    r = stored(f, key)
    expect(r).toMatchObject({ disposition: "closed_clean", collected: true })
    expect(r.closedAt).toBeDefined()
  })

  test("waiting again on a finished task changes nothing; a new send starts a new run", async () => {
    const f = context()
    const key = await started(f)
    await invoke(sendTool, { sessionID: SID, message: "go" }, f.ctx)
    settle(f, "idle", key)
    await invoke(waitTool, { sessionIDs: [SID] }, f.ctx)
    const first = stored(f, key)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await invoke(waitTool, { sessionIDs: [SID] }, f.ctx)
    await invoke(waitTool, { sessionIDs: [SID] }, f.ctx)
    expect(stored(f, key)).toEqual(first)

    await invoke(sendTool, { sessionID: SID, message: "again" }, f.ctx)
    expect(stored(f, key)).toMatchObject({ sendCount: 2, outcome: "running" })
    expect(stored(f, key).requestedModel).toBe("synapse/auto")
    settle(f, "error", key, "ProviderAuthError")
    await invoke(waitTool, { sessionIDs: [SID] }, f.ctx)
    expect(stored(f, key)).toMatchObject({ sendCount: 2, outcome: "error", errorCode: "ProviderAuthError" })
  })

  test("an error label outside the allowlist is stored as other", async () => {
    const f = context()
    const key = await started(f)
    await invoke(sendTool, { sessionID: SID, message: "go" }, f.ctx)
    settle(f, "error", key, "unrecognised error")
    await invoke(waitTool, { sessionIDs: [SID] }, f.ctx)
    expect(stored(f, key)).toMatchObject({ outcome: "error", errorCode: "other" })
  })

  test("a run that settles while the prompt POST is still in flight is completed, not left running", async () => {
    const f = context()
    const key = await started(f)
    const call = f.api.call.bind(f.api)
    let postAt = ""
    f.api.call = async (input) => {
      if (input.path.endsWith("/prompt_async")) {
        postAt = new Date().toISOString()
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
      return call(input)
    }
    await invoke(sendTool, { sessionID: SID, message: "go" }, f.ctx)
    f.hub.waitResult = { events: [], next: { epoch: "ep1", seq: 12 }, timedOut: false, views: [{ sessionID: SID, directory: `/sessions/${key}`, state: "idle", since: postAt }] }
    await invoke(waitTool, { sessionIDs: [SID] }, f.ctx)
    expect(stored(f, key).outcome).toBe("completed")
  })

  test("C1: a run nobody waited on is recorded from the state the close holds", async () => {
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["idle", {}, { outcome: "completed" }],
      ["error", { lastError: "ProviderAuthError" }, { outcome: "error", errorCode: "ProviderAuthError" }],
      // Cycle 3: idle is completed even with a label left over from an earlier run (the hub keeps it disarmed).
      ["idle", { lastError: "APIError" }, { outcome: "completed" }],
      ["aborted", {}, { outcome: "aborted" }],
    ]
    for (const [state, extra, expected] of cases) {
      const f = context()
      const key = await started(f)
      await invoke(sendTool, { sessionID: SID, message: "go" }, f.ctx)
      await new Promise((resolve) => setTimeout(resolve, 2))
      f.hub.views.set(SID, { sessionID: SID, directory: `/sessions/${key}`, state: state as "idle", since: new Date().toISOString(), ...extra })
      f.api.on(`DELETE /session/${SID}`, { status: 200, data: true })
      closeWith(f, {})
      expect((await invoke(closeSessionTool, { sessionID: SID }, f.ctx)).isError).toBeUndefined()
      expect(stored(f, key)).toMatchObject({ ...expected, disposition: "closed_clean" })
    }
  })

  test("C2: run 1 errors, run 2 is clean and nobody waits on it: the close records completed", async () => {
    const f = context()
    const key = await started(f)
    await invoke(sendTool, { sessionID: SID, message: "one" }, f.ctx)
    settle(f, "error", key, "ProviderAuthError")
    await invoke(waitTool, { sessionIDs: [SID] }, f.ctx)
    expect(stored(f, key).outcome).toBe("error")
    await invoke(sendTool, { sessionID: SID, message: "two" }, f.ctx)
    await new Promise((resolve) => setTimeout(resolve, 2))
    f.hub.views.set(SID, { sessionID: SID, directory: `/sessions/${key}`, state: "idle", since: new Date().toISOString(), lastError: "ProviderAuthError" })
    f.api.on(`DELETE /session/${SID}`, { status: 200, data: true })
    closeWith(f, {})
    await invoke(closeSessionTool, { sessionID: SID }, f.ctx)
    expect(stored(f, key)).toMatchObject({ outcome: "completed", sendCount: 2 })
  })

  test("oc_report includes this process's own queued updates", async () => {
    const f = context()
    const key = await started(f)
    writeFileSync(path.join(dir(f), `${key}.json.lock`), "held briefly")
    setTimeout(() => rmSync(path.join(dir(f), `${key}.json.lock`), { force: true }), 60)
    await invokeNow(sendTool, { sessionID: SID, message: "go" }, f.ctx)
    const report = await invokeNow(reportTool, { recent: 1 }, f.ctx)
    expect((data(report).recent as Array<{ sendCount: number }>)[0]?.sendCount).toBe(1)
  })

  test("shutdown waits for a queued record update (inside its time cap)", async () => {
    const f = context()
    const key = await started(f)
    writeFileSync(path.join(dir(f), `${key}.json.lock`), "held briefly")
    setTimeout(() => rmSync(path.join(dir(f), `${key}.json.lock`), { force: true }), 60)
    await invokeNow(sendTool, { sessionID: SID, message: "go" }, f.ctx)
    expect(stored(f, key).sendCount).toBe(0)
    await shutdownOnce({ stop: async () => {} }, { release: async () => {} }, silentLogger, 2000)("test")
    expect(stored(f, key).sendCount).toBe(1)
  })

  test("a held record lock never slows a tool: oc_send returns in well under 100 ms", async () => {
    const f = context()
    const key = await started(f)
    writeFileSync(path.join(dir(f), `${key}.json.lock`), "another process")
    const t0 = performance.now()
    const result = await invokeNow(sendTool, { sessionID: SID, message: "go" }, f.ctx)
    const ms = performance.now() - t0
    expect(result.isError).toBeUndefined()
    expect(ms).toBeLessThan(100)
    await flushReports()
    expect(stored(f, key).sendCount).toBe(0)
  })

  test("closing a task that is still running records unknown; closing with abort: true records aborted", async () => {
    const f = context()
    const key = await started(f)
    await invoke(sendTool, { sessionID: SID, message: "go" }, f.ctx)
    f.api.on(`DELETE /session/${SID}`, { status: 200, data: true })
    closeWith(f, {})
    await invoke(closeSessionTool, { sessionID: SID }, f.ctx)
    expect(stored(f, key)).toMatchObject({ outcome: "unknown", disposition: "closed_clean" })
    expect(stored(f, key).finishedAt).toBeDefined()

    const g = context()
    const key2 = await started(g)
    await invoke(sendTool, { sessionID: SID, message: "go" }, g.ctx)
    g.api.on(`DELETE /session/${SID}`, { status: 200, data: true })
    g.api.on(`POST /session/${SID}/abort`, { status: 200, data: true })
    g.hub.view = async (id: string) => ({ sessionID: id, directory: `/sessions/${key2}`, state: g.api.find("POST", `/session/${SID}/abort`) ? "idle" : "busy", since: new Date().toISOString() })
    closeWith(g, {})
    expect((await invoke(closeSessionTool, { sessionID: SID, abort: true }, g.ctx)).isError).toBeUndefined()
    expect(stored(g, key2)).toMatchObject({ outcome: "aborted", disposition: "closed_clean" })
  })

  test("a timed-out wait leaves a running task running", async () => {
    const f = context()
    const key = await started(f)
    await invoke(sendTool, { sessionID: SID, message: "go" }, f.ctx)
    f.hub.waitResult = { events: [], next: { epoch: "ep1", seq: 12 }, timedOut: true }
    f.hub.views.set(SID, { sessionID: SID, directory: `/sessions/${key}`, state: "busy", since: new Date().toISOString() })
    await invoke(waitTool, { sessionIDs: [SID], timeoutSec: 1 }, f.ctx)
    expect(stored(f, key).outcome).toBe("running")
  })

  test("an aborted run is recorded as aborted", async () => {
    const f = context()
    const key = await started(f)
    await invoke(sendTool, { sessionID: SID, message: "go" }, f.ctx)
    settle(f, "aborted", key)
    await invoke(waitTool, { sessionIDs: [SID] }, f.ctx)
    expect(stored(f, key).outcome).toBe("aborted")
  })

  test("a close that discarded work is closed_discarded", async () => {
    const f = context()
    const key = await started(f)
    f.api.on(`DELETE /session/${SID}`, { status: 200, data: true })
    closeWith(f, { uncollectedCommits: 2 })
    expect((await invoke(closeSessionTool, { sessionID: SID, discardWork: true }, f.ctx)).isError).toBeUndefined()
    expect(stored(f, key).disposition).toBe("closed_discarded")
  })

  test("a session swept by oc_cleanup is swept; a run still marked running becomes unknown", async () => {
    const f = context()
    const key = await started(f)
    await invoke(sendTool, { sessionID: SID, message: "go" }, f.ctx)
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    f.ctx.workspaces.closeCandidates = async () => ({ states: [{ sessionID: SID, sessionKey: key, createdAt: old, hostRepo: "C:\\GitHub\\demo-repo", base: "a".repeat(40) }], legacy: 0, otherBox: 0, otherBridge: 0 })
    f.api.on(`GET /session/${SID}`, { status: 404 })
    f.api.on(`DELETE /session/${SID}`, { status: 404 })
    closeWith(f, {})
    const result = await invoke(cleanupTool, { dryRun: false }, f.ctx)
    expect(data(result).closed).toEqual([key])
    expect(stored(f, key)).toMatchObject({ disposition: "swept", outcome: "unknown" })
  })
})

describe("record failures never fail a tool", () => {
  test("an unwritable report folder: start, send, wait, result, collect and close all still succeed, logged once", async () => {
    const f = context()
    const lines: string[] = []
    f.ctx.log = { log: (level, _component, msg, fields) => lines.push(`${level} ${msg} ${JSON.stringify(fields ?? {})}`) }
    mkdirSync(path.dirname(dir(f)), { recursive: true })
    writeFileSync(dir(f), "a file where the folder should be")
    const key = await started(f)
    expect((await invoke(sendTool, { sessionID: SID, message: MARKER }, f.ctx)).isError).toBeUndefined()
    settle(f, "idle", key)
    expect((await invoke(waitTool, { sessionIDs: [SID] }, f.ctx)).isError).toBeUndefined()
    f.api.on(`GET /session/${SID}/message?limit=8`, { status: 200, data: [] })
    expect((await invoke(resultTool, { sessionID: SID }, f.ctx)).isError).toBeUndefined()
    expect((await invoke(collectTool, { sessionID: SID }, f.ctx)).isError).toBeUndefined()
    f.api.on(`DELETE /session/${SID}`, { status: 200, data: true })
    closeWith(f, {})
    expect((await invoke(closeSessionTool, { sessionID: SID }, f.ctx)).isError).toBeUndefined()
    const warned = lines.filter((l) => l.includes("task record"))
    expect(warned).toHaveLength(1)
    expect(warned[0]).not.toContain(MARKER)
    expect(warned[0]).not.toContain(f.ctx.config.home)
  })

  test("a hook that throws synchronously is swallowed", async () => {
    const f = context()
    // A config with no home makes path.join throw inside the hook.
    const key = await started(f)
    f.ctx.config = { ...f.ctx.config, home: undefined as unknown as string }
    expect((await invoke(sendTool, { sessionID: SID, message: "go" }, f.ctx)).isError).toBeUndefined()
    expect(key).toBeTruthy()
  })
})

describe("no prompt text in any record", () => {
  test("the marker sent in a prompt and echoed by the agent is absent from every file", async () => {
    const f = context()
    const key = await started(f)
    await invoke(sendTool, { sessionID: SID, message: `Please handle ${MARKER} carefully` }, f.ctx)
    settle(f, "idle", key)
    await invoke(waitTool, { sessionIDs: [SID] }, f.ctx)
    f.api.on(`GET /session/${SID}/message?limit=8`, { status: 200, data: [assistant("synapse", "auto", { input: 1, output: 1 })] })
    await invoke(resultTool, { sessionID: SID }, f.ctx)
    await invoke(collectTool, { sessionID: SID }, f.ctx)
    const files = readdirSync(dir(f))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) expect(readFileSync(path.join(dir(f), name), "utf8")).not.toContain(MARKER)
    const report = await invoke(reportTool, { recent: 5 }, f.ctx)
    expect(JSON.stringify(report)).not.toContain(MARKER)
  })
})

describe("oc_report", () => {
  test("is registered, read-only and validates its input", () => {
    const tool = allTools().find((t) => t.name === "oc_report")
    expect(tool).toBeDefined()
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    expect(tool?.description).toContain("success rate")
    const schema = z.object(reportTool.input)
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ sinceDays: 7, groupBy: "repo", recent: 50 }).success).toBe(true)
    expect(schema.safeParse({ sinceDays: 0 }).success).toBe(false)
    expect(schema.safeParse({ sinceDays: 366 }).success).toBe(false)
    expect(schema.safeParse({ sinceDays: 1.5 }).success).toBe(false)
    expect(schema.safeParse({ groupBy: "caller" }).success).toBe(true)
    expect(schema.safeParse({ groupBy: "bridge" }).success).toBe(false)
    expect(schema.safeParse({ recent: 51 }).success).toBe(false)
  })

  test("structured totals, groups and recent rows; agent-written strings are under untrusted", async () => {
    const f = context()
    const key = await started(f)
    await invoke(sendTool, { sessionID: SID, message: "go", agent: "build" }, f.ctx)
    settle(f, "idle", key)
    await invoke(waitTool, { sessionIDs: [SID] }, f.ctx)
    const result = await invoke(reportTool, { groupBy: "agent", recent: 3 }, f.ctx)
    expect(result.isError).toBeUndefined()
    const d = data(result)
    expect(d).toMatchObject({ sinceDays: 30, groupBy: "agent" })
    expect(d.totals).toMatchObject({ tasks: 1, completed: 1, finished: 1, successRate: 1 })
    const groups = d.groups as Array<Record<string, unknown>>
    expect(groups[0]?.name).toEqual({ text: "build", truncated: false })
    const recent = d.recent as Array<Record<string, unknown>>
    expect(recent[0]).toMatchObject({ key, sessionID: SID, outcome: "completed", agent: { text: "build", truncated: false }, repo: { text: "demo-repo", truncated: false } })
    const line = text(result).split("\n")[0] ?? ""
    expect(line).toContain("1 task in the last 30 days")
    expect(line).toContain("success rate 100% of 1 finished")
    expect(line).not.toContain("build")
    expect(recent[0]).not.toHaveProperty("servedModel")
  })

  test("#132 / #136: groupBy caller names the session; legacy caller-less record gives (unknown)", async () => {
    const f = context()
    const key = await started(f)
    // #136: persist a caller-less (legacy) record too
    const legacyRec = stored(f, key)
    delete (legacyRec as { caller?: string }).caller
    writeFileSync(path.join(dir(f), "legacy-key.json"), JSON.stringify({ ...legacyRec, key: "legacy-key" }))
    const result = await invoke(reportTool, { groupBy: "caller", recent: 2 }, f.ctx)
    expect(result.isError).toBeUndefined()
    const d = data(result)
    expect(d.groupBy).toBe("caller")
    const groupNames = (d.groups as Array<{ name: { text: string } }>).map((g) => g.name.text)
    expect(groupNames).toContain("test-caller")
    expect(groupNames).toContain("(unknown)")
    expect((d.recent as Array<Record<string, unknown>>).some((r) => r.key === key && (r.caller as { text: string })?.text === "test-caller")).toBe(true)
    expect((d.recent as Array<Record<string, unknown>>).some((r) => r.key === "legacy-key" && !r.caller)).toBe(true)
    expect(reportTool.description).toContain("caller")
  })

  test("notes say synapse/auto hides the routed model, servedModel shows it (#76), and tokens are a lower bound", async () => {
    const f = context()
    const result = await invoke(reportTool, {}, f.ctx)
    const notes = data(result).notes as string[]
    expect(notes).toHaveLength(3)
    expect(notes[0]).toContain("synapse/auto")
    expect(notes[0]).toContain("servedModel")
    expect(notes[1]).toContain("session id")
    expect(notes[2]).toContain("lower bound")
    expect(reportTool.description).toContain("unknown")
    expect(reportTool.description).toContain("servedModel")
  })

  test("an empty folder gives an empty report, not an error", async () => {
    const f = context()
    const result = await invoke(reportTool, {}, f.ctx)
    expect(result.isError).toBeUndefined()
    expect(data(result).totals).toMatchObject({ tasks: 0, successRate: null })
    expect(text(result)).toContain("No tasks")
  })
})

describe("#76 served models through the tools", () => {
  test("oc_result stores the served-model counts read from front; oc_report groups by them", async () => {
    const f = context()
    const reads: Array<{ sessionID: string; since: string }> = []
    f.ctx.servedModels = async (sessionID, since) => (reads.push({ sessionID, since }), { "qwen/qwen3.8-flash": 3, "google/gemini-3.1-pro": 1 })
    const key = await started(f)
    expect((await invoke(sendTool, { sessionID: SID, message: "task", model: "synapse/auto" }, f.ctx)).isError).toBeUndefined()
    settle(f, "idle", key)
    f.api.on(`GET /session/${SID}/message?limit=8`, { status: 200, data: [] })
    expect((await invoke(resultTool, { sessionID: SID }, f.ctx)).isError).toBeUndefined()
    const r = stored(f, key)
    expect(r.servedModels).toEqual({ "qwen/qwen3.8-flash": 3, "google/gemini-3.1-pro": 1 })
    expect(reads[0]).toEqual({ sessionID: SID, since: r.firstSendAt! })

    const report = data(await invoke(reportTool, { groupBy: "servedModel", recent: 1 }, f.ctx))
    expect((report.groups as Array<{ name: { text: string } }>).map((g) => g.name.text)).toEqual(["qwen/qwen3.8-flash"])
    expect((report.recent as Array<Record<string, unknown>>)[0]?.servedModels).toEqual({ "qwen/qwen3.8-flash": 3, "google/gemini-3.1-pro": 1 })
  })

  test("an unreadable log, or a smaller read after a restart, leaves the stored counts alone", async () => {
    const f = context()
    let next: Record<string, number> | undefined = { "a/x": 2 }
    f.ctx.servedModels = async () => next
    const key = await started(f)
    await invoke(sendTool, { sessionID: SID, message: "task" }, f.ctx)
    settle(f, "idle", key)
    f.api.on(`GET /session/${SID}/message?limit=8`, { status: 200, data: [] })
    await invoke(resultTool, { sessionID: SID }, f.ctx)
    expect(stored(f, key).servedModels).toEqual({ "a/x": 2 })
    next = undefined
    await invoke(resultTool, { sessionID: SID }, f.ctx)
    next = { "b/y": 1 }
    await invoke(resultTool, { sessionID: SID }, f.ctx)
    expect(stored(f, key).servedModels).toEqual({ "a/x": 2 })
  })
})
