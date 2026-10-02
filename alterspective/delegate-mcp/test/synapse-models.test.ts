// #71: the box offers only the models registered in Synapse. The bridge reads them on the HOST
// (GET /v1/models with the host-held token front uses); any failure falls back to `auto` only and
// never stops a box start. No live network: fetch is a fake.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { authConf, authConfPath } from "../src/synapse/auth-conf.ts"
import { FALLBACK_MODELS, MODELS_TIMEOUT_MS, SYNAPSE_MODELS_URL, registeredModels } from "../src/synapse/models.ts"

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlLXZhbHVl"

type Seen = { url: string; auth: string | null; signal: boolean }

function fakeFetch(reply: () => Response | Promise<Response>, seen: Seen[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    seen.push({ url: String(input), auth: headers.get("authorization"), signal: init?.signal instanceof AbortSignal })
    return reply()
  }) as typeof fetch
}

async function withFront(token: string | undefined, fn: (frontDir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocd-models-"))
  try {
    if (token !== null) await writeFile(authConfPath(dir), authConf(token), "utf8")
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const list = (ids: unknown[]) => new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }), { status: 200 })

describe("registeredModels (#71)", () => {
  test("lists Synapse's ids as returned, with auto, sorted and de-duplicated, using the host-held token", async () => {
    await withFront(TOKEN, async (frontDir) => {
      const seen: Seen[] = []
      const got = await registeredModels({ frontDir, fetch: fakeFetch(() => list(["openai/gpt-5.6-sol", "qwen3-next-80b", "openai/gpt-5.6-sol"]), seen) })
      expect(got).toEqual({ models: ["auto", "openai/gpt-5.6-sol", "qwen3-next-80b"], limits: {}, source: "synapse" })
      expect(seen).toEqual([{ url: SYNAPSE_MODELS_URL, auth: `Bearer ${TOKEN}`, signal: true }])
      expect(SYNAPSE_MODELS_URL).toBe("https://synapse2-api.alterspective.com.au/v1/models")
    })
  })

  test("drops ids that are not model ids (box config data) and keeps auto when Synapse lists it", async () => {
    await withFront(TOKEN, async (frontDir) => {
      const got = await registeredModels({ frontDir, fetch: fakeFetch(() => list(["auto", "has space", "", 42, "../x", "a".repeat(200), "claude-sonnet-4-6"])) })
      expect(got.models).toEqual(["auto", "claude-sonnet-4-6"])
    })
  })

  test("contextWindow/maxOutput become limits; entries that are not chat-capable are left out (#71 director note)", async () => {
    await withFront(TOKEN, async (frontDir) => {
      const body = {
        object: "list",
        data: [
          { id: "anthropic/claude-opus-5", contextWindow: 200000, maxOutput: 32000, capabilities: { ops: ["chat", "vision"] } },
          { id: "ornith-1.0-35b", contextWindow: 131072, capabilities: { ops: ["chat"] } },
          { id: "qwen3.8-27b-dflash2", capabilities: { ops: [] } },
          { id: "nomic-embed-text", capabilities: { ops: ["embed"] } },
          { id: "nvidia/llama-nemotron-rerank-1b-v2", capabilities: { ops: ["rerank"] } },
          { id: "bad-limit", contextWindow: -1, maxOutput: 1.5 },
        ],
      }
      const got = await registeredModels({ frontDir, fetch: fakeFetch(() => new Response(JSON.stringify(body), { status: 200 })) })
      expect(got).toEqual({
        models: ["auto", "anthropic/claude-opus-5", "bad-limit", "ornith-1.0-35b", "qwen3.8-27b-dflash2"],
        limits: { "anthropic/claude-opus-5": { context: 200000, output: 32000 } },
        source: "synapse",
      })
    })
  })

  test("no include, or an include without a token: fallback to auto, and Synapse is not called", async () => {
    for (const token of [undefined, null] as const) {
      await withFront(token === null ? undefined : token, async (frontDir) => {
        if (token === null) await rm(authConfPath(frontDir), { force: true })
        const seen: Seen[] = []
        const got = await registeredModels({ frontDir, fetch: fakeFetch(() => list(["x"]), seen) })
        expect(got).toEqual({ models: [...FALLBACK_MODELS], limits: {}, source: "fallback", reason: "no host-held Synapse token (run oc_login {server:\"synapse\"})" })
        expect(seen).toEqual([])
      })
    }
  })

  test("an HTTP error, a bad body, an empty list or a network failure: fallback, and the reason never holds the token", async () => {
    const replies: Array<[() => Response | Promise<Response>, string]> = [
      [() => new Response("nope", { status: 401 }), "Synapse answered HTTP 401"],
      [() => new Response("not json", { status: 200 }), "Synapse's model list was not readable"],
      [() => new Response(JSON.stringify({ data: "x" }), { status: 200 }), "Synapse's model list was not readable"],
      [() => list([]), "Synapse listed no usable model ids"],
      [() => Promise.reject(new Error(`boom ${TOKEN}`)), "Synapse could not be reached"],
    ]
    for (const [reply, reason] of replies) {
      await withFront(TOKEN, async (frontDir) => {
        const got = await registeredModels({ frontDir, fetch: fakeFetch(reply) })
        expect(got).toEqual({ models: [...FALLBACK_MODELS], limits: {}, source: "fallback", reason })
        expect(JSON.stringify(got)).not.toContain(TOKEN)
      })
    }
  })

  test("a Synapse that never answers is cut off by the bridge's own deadline (fallback, never a hang)", async () => {
    await withFront(TOKEN, async (frontDir) => {
      const hang = (async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))))) as typeof fetch
      const started = Date.now()
      const got = await registeredModels({ frontDir, fetch: hang, timeoutMs: 50 })
      expect(got).toEqual({ models: [...FALLBACK_MODELS], limits: {}, source: "fallback", reason: "Synapse did not answer within 50 ms" })
      expect(Date.now() - started).toBeLessThan(2000)
      expect(MODELS_TIMEOUT_MS).toBeLessThanOrEqual(5000)
    })
  })
})
