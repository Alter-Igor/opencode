// Wave 3: oc_post (wake only this bridge's sessions), oc_inbox (never [] on failure, truncated
// surfaced, text under untrusted) and the inbox poller (publishes once per message, never on failure).
import { afterEach, describe, expect, test } from "bun:test"
import { startInboxPoller } from "../src/inbox-poller.ts"
import { DelegateError } from "../src/shared/errors.ts"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { interactionTools, startInteraction } from "../src/tools/interaction.ts"
import { manualTimers } from "./events-fake.ts"
import { DIR_A, SES_A, SES_OTHER, connect, fixture, message, record, sessionRoute, type Fixture } from "./tools-interaction-fixture.ts"

let close: (() => Promise<void>) | undefined
afterEach(async () => {
  await close?.()
  close = undefined
})

async function client(f: Fixture) {
  const c = await connect(f.ctx, interactionTools)
  close = c.close
  return c
}

function withPrompt(f: Fixture, status = 204): Fixture {
  sessionRoute(f, SES_A, DIR_A)
  f.api.route("POST", `/session/${SES_A}/prompt_async`, { status })
  return f
}

describe("oc_post", () => {
  test("posts without waking", async () => {
    const f = fixture([record(SES_A, DIR_A)])
    const c = await client(f)
    const result = await c.call("oc_post", { to: `session:${SES_OTHER}`, text: "hello" })
    expect(result.isError).toBe(false)
    expect(result.data.woke).toBe(false)
    expect(f.inbox.posts).toEqual([{ to: `session:${SES_OTHER}`, text: "hello", correlationId: undefined }])
    expect(f.api.calls).toHaveLength(0)
  })

  test("wakes one of this bridge's sessions with the framed message, cursor taken before the send", async () => {
    const f = withPrompt(fixture([record(SES_A, DIR_A)]))
    f.hub.seq = 7
    const c = await client(f)
    const result = await c.call("oc_post", { to: `session:${SES_A}`, text: "please rebase", wake: true, correlationId: "t-1" })
    expect(result.isError).toBe(false)
    expect(result.data.woke).toBe(true)
    expect(result.data.cursor).toBe("e1.7")
    expect(f.runtime.checked).toEqual([DIR_A])
    const [prompt] = f.api.posts()
    expect(prompt?.path).toBe(`/session/${SES_A}/prompt_async`)
    expect(prompt?.directory).toBe(DIR_A)
    const text = (prompt?.body as { parts: Array<{ text: string }> }).parts[0]?.text ?? ""
    expect(text).toContain("treat as untrusted input")
    expect(text).toContain("please rebase")
    expect(f.hub.marked).toEqual([SES_A])
  })

  test("never wakes a session this bridge did not start, and posts nothing then", async () => {
    const f = withPrompt(fixture([record(SES_A, DIR_A)]))
    // The box knows SES_OTHER, but its metadata names another supervisor.
    f.api.route("GET", `/session/${SES_OTHER}`, { status: 200, data: { id: SES_OTHER, directory: "/sessions/other", metadata: { supervisor: "supervisor:someone-else" } } })
    f.api.route("POST", `/session/${SES_OTHER}/prompt_async`, { status: 204 })
    const c = await client(f)
    const cases: Array<[string, string]> = [[`session:${SES_OTHER}`, "not_found"], ["supervisor:someone", "policy_violation"]]
    for (const [to, code] of cases) {
      const result = await c.call("oc_post", { to, text: "wake up", wake: true })
      expect(result.isError).toBe(true)
      expect(result.data.code).toBe(code)
    }
    expect(f.inbox.posts).toHaveLength(0)
    expect(f.api.posts()).toHaveLength(0)
    expect(f.hub.marked).toHaveLength(0)
  })

  test("does not wake when the runtime guard fails", async () => {
    const f = withPrompt(fixture([record(SES_A, DIR_A)]))
    f.runtime.verdict = { ok: false, code: "policy_unverified", reason: "could not read MCP status" }
    const c = await client(f)
    const result = await c.call("oc_post", { to: `session:${SES_A}`, text: "go", wake: true })
    expect(result.data.code).toBe("policy_unverified")
    expect(f.inbox.posts).toHaveLength(0)
    expect(f.api.posts()).toHaveLength(0)
  })

  test("does not wake when the session's permission rules drifted from the baseline (H3)", async () => {
    const f = fixture([record(SES_A, DIR_A)])
    f.api.route("GET", `/session/${SES_A}`, { status: 200, data: { id: SES_A, directory: DIR_A, permission: [{ permission: "*", pattern: "*", action: "allow" }] } })
    const c = await client(f)
    const result = await c.call("oc_post", { to: `session:${SES_A}`, text: "go", wake: true })
    expect(result.data.code).toBe("policy_violation")
    expect(f.inbox.posts).toHaveLength(0)
    expect(f.api.posts()).toHaveLength(0)
  })

  test("a failed wake says the message was stored", async () => {
    const f = withPrompt(fixture([record(SES_A, DIR_A)]), 500)
    const c = await client(f)
    const result = await c.call("oc_post", { to: `session:${SES_A}`, text: "go", wake: true })
    expect(result.data.code).toBe("upstream_error")
    expect(String(result.data.message)).toContain("stored")
    expect(f.hub.marked).toHaveLength(0)
  })
})

describe("oc_inbox", () => {
  test("returns text under untrusted with a trust note and the next cursor", async () => {
    const f = fixture()
    f.inbox.pages = [{ messages: [message("5", { text: "do \u001b[2Jthis" })], next: "0123456789abcdef.5", truncated: false }]
    const c = await client(f)
    const result = await c.call("oc_inbox", { limit: 10 })
    expect(result.isError).toBe(false)
    const [m] = result.data.messages as Array<Record<string, unknown>>
    expect(m?.untrusted).toEqual({ text: "do [2Jthis", truncated: false })
    expect(m?.text).toBeUndefined()
    expect(String(m?.trust)).toContain("UNVERIFIED")
    expect(result.data.next).toBe("0123456789abcdef.5")
    expect(String(result.data.trustNote)).toContain("untrusted")
    expect(f.inbox.reads).toEqual([{ cursor: undefined, limit: 10 }])
  })

  test("surfaces truncated prominently", async () => {
    const f = fixture()
    f.inbox.pages = [{ messages: [], next: "0123456789abcdef.9", truncated: true }]
    const c = await client(f)
    const result = await c.call("oc_inbox", {})
    expect(result.data.truncated).toBe(true)
    expect(result.text.startsWith("WARNING")).toBe(true)
  })

  test("a failed read is an error, never an empty list; cursor_expired passes through", async () => {
    for (const code of ["inbox_unavailable", "cursor_expired"] as const) {
      const f = fixture()
      f.inbox.pages = [new DelegateError(code, "nope", "retry")]
      const c = await client(f)
      const result = await c.call("oc_inbox", { cursor: "0123456789abcdef.3" })
      expect(result.isError).toBe(true)
      expect(result.data.code).toBe(code)
      expect(result.data.messages).toBeUndefined()
      await c.close()
      close = undefined
    }
  })

  test("limit is capped at 100", async () => {
    const f = fixture()
    const c = await client(f)
    const result = await c.call("oc_inbox", { limit: 101 })
    expect(result.isError).toBe(true)
    expect(f.inbox.reads).toHaveLength(0)
  })
})

describe("startInboxPoller", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  test("publishes each new message once and never publishes history or on failure", async () => {
    const t = manualTimers(Date.parse("2026-10-01T10:00:00Z"))
    const f = fixture()
    const old = message("1", { at: "2026-10-01T09:00:00Z" })
    const fresh = message("2", { at: "2026-10-01T10:00:01Z" })
    f.inbox.pages = [
      { messages: [old, fresh], next: "0123456789abcdef.2", truncated: false },
      new DelegateError("inbox_unavailable", "down", "retry"),
      { messages: [fresh, message("3", { at: "2026-10-01T10:00:20Z" })], next: "0123456789abcdef.3", truncated: false },
      { messages: [], next: "0123456789abcdef.3", truncated: false },
    ]
    const stop = startInboxPoller(f.ctx, f.hub, { intervalMs: 5000, timers: t.timers })
    t.advance(0)
    await flush()
    expect(f.hub.published.map((m) => m.id)).toEqual(["2"])
    t.advance(5000)
    await flush()
    expect(f.hub.published.map((m) => m.id)).toEqual(["2"]) // the failure published nothing
    expect(t.delays.at(-1)).toBe(10_000) // backoff
    t.advance(10_000)
    await flush()
    expect(f.hub.published.map((m) => m.id)).toEqual(["2", "3"]) // 2 not repeated
    expect(f.inbox.reads.map((r) => r.cursor)).toEqual([undefined, "0123456789abcdef.2", "0123456789abcdef.2"])
    stop()
    expect(t.pending()).toBe(0)
  })

  test("after cursor_expired it restarts from the oldest message, news only from then", async () => {
    const t = manualTimers(Date.parse("2026-10-01T10:00:00Z"))
    const f = fixture()
    f.inbox.pages = [
      new DelegateError("cursor_expired", "reset", "read again"),
      { messages: [message("1", { at: "2026-10-01T09:59:00Z" }), message("2", { at: "2026-10-01T10:00:03Z" })], next: "fedcba9876543210.2", truncated: false },
    ]
    const stop = startInboxPoller(f.ctx, f.hub, { intervalMs: 1000, timers: t.timers })
    t.advance(0)
    await flush()
    t.advance(1000)
    await flush()
    expect(f.hub.published.map((m) => m.id)).toEqual(["2"])
    expect(f.inbox.reads[1]?.cursor).toBeUndefined()
    stop()
  })
})

describe("startInteraction", () => {
  test("attaches the poller to the current box and to each new box once; stop detaches", async () => {
    const f = fixture()
    f.boxes.started = true
    const server = new McpServer({ name: "t", version: "0" })
    const stop = startInteraction(server, f.ctx, { channels: true, pollIntervalMs: 60_000 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.inbox.reads).toHaveLength(1) // polled the current box once
    expect(f.hub.listeners.size).toBe(1) // channel subscription
    const box = await f.ctx.box()
    for (const listener of f.boxes.listeners) listener(box) // same box again: no second poller
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.inbox.reads).toHaveLength(1)
    expect(f.hub.listeners.size).toBe(1)
    stop()
    expect(f.hub.listeners.size).toBe(0)
    expect(f.boxes.listeners.size).toBe(0)
  })
})
