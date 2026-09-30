// FEAT-OCD-001 MOD-05 T5.1: the inbox sidecar's limits over real HTTP: hop counting (the
// sidecar's own; client claims ignored), rate budgets and their order, and refusal-log sampling.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LogSampler, RateLimiter } from "../inbox-sidecar/src/limits.ts"
import { BOX_ROUTE_PER_MINUTE, BOX_TO_SUPERVISOR_PER_MINUTE, HOP_LIMIT, MAX_TEXT_BYTES, type StoredMessage } from "../inbox-sidecar/src/rules.ts"
import { startSidecar, type Sidecar } from "./inbox-harness.ts"

const TOKEN = "t".repeat(20) + "0123456789AB"
const SES_A = "session:ses_AAAAAAAAAA01"
const SES_B = "session:ses_BBBBBBBBBB02"
const SUP = "supervisor:claude-a"

let dir: string
let servers: Sidecar[] = []
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ocd-inbox-limits-"))
  servers = []
})
afterEach(async () => {
  for (const server of servers) server.stop()
  await rm(dir, { recursive: true, force: true })
})

function serve(): Sidecar & { clock: { now: number } } {
  const clock = { now: Date.parse("2026-10-01T00:00:00Z") }
  const server = startSidecar({ dir, token: TOKEN, now: () => clock.now })
  servers.push(server)
  return { ...server, clock }
}

type Reply = { status: number; body: { message?: StoredMessage; error?: { code: string } } }

async function post(url: string, body: unknown, token?: string): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(url, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as Reply["body"] }
}

const boxPost = (s: Sidecar, body: unknown) => post(`${s.boxUrl}/v1/post`, body)
const adminPost = (s: Sidecar, body: unknown) => post(`${s.adminUrl}/v1/admin/post`, body, TOKEN)
const fake = (i: number) => `session:ses_FAKE${String(i).padStart(6, "0")}`

describe("inbox sidecar: hops (W2C-07)", () => {
  test(`hop limit ${HOP_LIMIT}: a box thread takes ${HOP_LIMIT + 1} messages, the next is 429 hop_limit`, async () => {
    const s = serve()
    const thread = { correlationId: "loop-1" }
    expect((await adminPost(s, { as: SUP, to: SES_A, text: "go", ...thread })).body.message!.hops).toBe(0)
    expect((await boxPost(s, { from: SES_A, to: SES_B, text: "ping", ...thread })).body.message!.hops).toBe(1)
    expect((await boxPost(s, { from: SES_B, to: SES_A, text: "pong", ...thread })).body.message!.hops).toBe(2)
    expect((await boxPost(s, { from: SES_A, to: SES_B, text: "ping", ...thread })).body.message!.hops).toBe(3)
    const over = await boxPost(s, { from: SES_B, to: SES_A, text: "pong", ...thread })
    expect(over.status).toBe(429)
    expect(over.body.error!.code).toBe("hop_limit")
  })

  test("a client's hops claim is ignored: it can neither reset a thread nor block a new one", async () => {
    const s = serve()
    const fresh = await boxPost(s, { from: SES_A, to: SES_B, text: "x", hops: 99 })
    expect(fresh.status).toBe(201)
    expect(fresh.body.message!.hops).toBe(0)
    for (let i = 0; i <= HOP_LIMIT; i++) expect((await boxPost(s, { from: SES_A, to: SES_B, text: "x", hops: 0, correlationId: "t" })).status).toBe(201)
    expect((await boxPost(s, { from: SES_A, to: SES_B, text: "x", hops: 0, correlationId: "t" })).body.error!.code).toBe("hop_limit")
  })

  test("box posts cannot use up a supervisor's hops on its own thread (hop poisoning)", async () => {
    const s = serve()
    const thread = { correlationId: "task-1" }
    expect((await adminPost(s, { as: SUP, to: SES_A, text: "please run the tests", ...thread })).status).toBe(201)
    for (let i = 0; i < HOP_LIMIT; i++) expect((await boxPost(s, { from: fake(i), to: SES_A, text: "noise", ...thread })).status).toBe(201)
    expect((await boxPost(s, { from: fake(9), to: SES_A, text: "noise", ...thread })).body.error!.code).toBe("hop_limit")
    const reply = await adminPost(s, { as: SUP, to: SES_A, text: "still here: also run lint", ...thread })
    expect(reply.status).toBe(201)
    expect(reply.body.message).toMatchObject({ verified: true, correlationId: "task-1", hops: HOP_LIMIT + 1 })
  })

  test("the supervisor's own posts still count: a thread takes 4 of them, then hop_limit", async () => {
    const s = serve()
    const thread = { correlationId: "sup-only" }
    for (let i = 0; i <= HOP_LIMIT; i++) expect((await adminPost(s, { as: SUP, to: SES_A, text: `m${i}`, ...thread })).status).toBe(201)
    expect((await adminPost(s, { as: SUP, to: SES_A, text: "again", ...thread })).body.error!.code).toBe("hop_limit")
  })

  test("a hop-refused post does not use rate budget (the hop check runs first)", async () => {
    const s = serve()
    for (let i = 0; i <= HOP_LIMIT; i++) await boxPost(s, { from: fake(i), to: SES_B, text: "x", correlationId: "full" })
    for (let i = 0; i < 20; i++) expect((await boxPost(s, { from: SES_A, to: SES_B, text: "x", correlationId: "full" })).status).toBe(429)
    expect((await boxPost(s, { from: SES_A, to: SES_B, text: "fresh thread" })).status).toBe(201)
  })
})

describe("inbox sidecar: rate budgets (W2C-09, W2C-10)", () => {
  test("10 messages a minute per claimed sender, then 429; the window slides", async () => {
    const s = serve()
    for (let i = 0; i < 10; i++) expect((await boxPost(s, { from: SES_A, to: SES_B, text: `m${i}` })).status).toBe(201)
    const limited = await boxPost(s, { from: SES_A, to: SES_B, text: "m10" })
    expect(limited.status).toBe(429)
    expect(limited.body.error!.code).toBe("rate_limited")
    expect((await boxPost(s, { from: SES_B, to: SES_A, text: "other sender" })).status).toBe(201)
    s.clock.now += 60_000
    expect((await boxPost(s, { from: SES_A, to: SES_B, text: "later" })).status).toBe(201)
  })

  test(`rotating made-up senders still hits the box-to-sessions cap (${BOX_ROUTE_PER_MINUTE}/min)`, async () => {
    const s = serve()
    let refused = 0
    for (let i = 0; i <= BOX_ROUTE_PER_MINUTE; i++) if ((await boxPost(s, { from: fake(i), to: SES_B, text: "spam" })).status === 429) refused++
    expect(refused).toBe(1)
  })

  test(`box-to-supervisor messages have their own budget (${BOX_TO_SUPERVISOR_PER_MINUTE}/min), so session spam cannot starve them`, async () => {
    const s = serve()
    for (let i = 0; i < BOX_ROUTE_PER_MINUTE; i++) await boxPost(s, { from: fake(i), to: SES_B, text: "spam" })
    expect((await boxPost(s, { from: fake(500), to: SES_B, text: "spam" })).status).toBe(429)
    for (let i = 0; i < BOX_TO_SUPERVISOR_PER_MINUTE; i++) expect((await boxPost(s, { from: fake(1000 + i), to: SUP, text: "status" })).status).toBe(201)
    const over = await boxPost(s, { from: fake(2000), to: SUP, text: "status" })
    expect(over.status).toBe(429)
    expect(over.body.error!.code).toBe("rate_limited")
    expect((await adminPost(s, { as: SUP, to: SES_A, text: "the bridge is not limited by box budgets" })).status).toBe(201)
  })

  test("the limiter caps tracked keys: a new key past the cap is refused, prune frees idle keys", () => {
    const clock = { now: 0 }
    const limiter = new RateLimiter(10, () => clock.now, 3)
    for (const key of ["a", "b", "c"]) expect(limiter.take(key)).toBe("ok")
    expect(limiter.take("d")).toBe("full")
    expect(limiter.take("a")).toBe("ok")
    expect(limiter.size).toBe(3)
    clock.now += 60_000
    limiter.prune()
    expect(limiter.size).toBe(0)
    expect(limiter.take("d")).toBe("ok")
  })

  test("text over 8 KB is 413; exactly 8 KB is accepted; multi-byte text counts bytes", async () => {
    const s = serve()
    expect((await boxPost(s, { from: SES_A, to: SES_B, text: "a".repeat(MAX_TEXT_BYTES) })).status).toBe(201)
    const over = await boxPost(s, { from: SES_A, to: SES_B, text: "a".repeat(MAX_TEXT_BYTES + 1) })
    expect(over.status).toBe(413)
    expect(over.body.error!.code).toBe("text_too_large")
    expect((await boxPost(s, { from: SES_A, to: SES_B, text: "é".repeat(MAX_TEXT_BYTES / 2 + 1) })).status).toBe(413)
    expect((await boxPost(s, { from: SES_A, to: SES_B, text: "a".repeat(40_000) })).body.error!.code).toBe("body_too_large")
  })

  test("bad addresses, cursors, limits and bodies are 400", async () => {
    const s = serve()
    for (const from of ["session:abc", "ses_AAAAAAAAAA01", "session:ses_short", "session:ses_AAAAAAAAAA01 ", ""])
      expect((await boxPost(s, { from, to: SES_B, text: "x" })).body.error!.code).toBe("bad_address")
    for (const to of ["supervisor:Claude", "supervisor:", `supervisor:${"a".repeat(41)}`, "user:igor"])
      expect((await boxPost(s, { from: SES_A, to, text: "x" })).body.error!.code).toBe("bad_address")
    for (const [query, code] of [["cursor=-1", "bad_cursor"], ["limit=0", "bad_limit"], ["limit=201", "bad_limit"]] as const) {
      const res = await fetch(`${s.boxUrl}/v1/read?to=${SES_A}&${query}`)
      expect(((await res.json()) as Reply["body"]).error!.code).toBe(code)
    }
    expect((await boxPost(s, { from: SES_A, to: SES_B, text: "x", correlationId: "has space" })).body.error!.code).toBe("bad_correlation_id")
    expect((await boxPost(s, "{nope")).status).toBe(400)
  })
})

describe("inbox sidecar: refusal log sampling (W2C-06)", () => {
  test("a flood of bad requests logs at most 30 refusal lines a minute, then one count of the rest", async () => {
    const s = serve()
    for (let i = 0; i < 100; i++) await boxPost(s, { from: "bad", to: SES_B, text: "x" })
    expect(s.logs.filter((line) => line.event === "refused").length).toBe(30)
    s.handlers.prune()
    expect(s.logs.filter((line) => line.event === "refused_suppressed")).toEqual([{ level: "warn", event: "refused_suppressed", count: 70 }])
    s.clock.now += 60_000
    await boxPost(s, { from: "bad", to: SES_B, text: "x" })
    expect(s.logs.filter((line) => line.event === "refused").length).toBe(31)
  })

  test("LogSampler counts what it drops and resets on flush", () => {
    const clock = { now: 0 }
    const sampler = new LogSampler(2, () => clock.now)
    expect([sampler.allow(), sampler.allow(), sampler.allow()]).toEqual([true, true, false])
    expect(sampler.flush()).toBe(1)
    expect(sampler.flush()).toBe(0)
  })
})
