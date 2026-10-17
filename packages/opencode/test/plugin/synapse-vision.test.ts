import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { ModelMessage } from "ai"
import {
  askSynapseVision,
  isInsideDir,
  markSynapseVisionReady,
  resolveVisionImage,
  saveImageForVision,
  synapseVisionBody,
  visionNote,
} from "@/plugin/synapse-vision"
import { proxyUnsupportedImages } from "@/provider/vision-proxy"

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

describe("synapse_vision (#193)", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-vision-"))
  })

  afterEach(async () => {
    markSynapseVisionReady(false)
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("the request puts the question and the image in one user message, model auto", () => {
    const body = synapseVisionBody({ imageUrl: "data:image/png;base64,AAA", question: "Is there an error banner?" })
    expect(body.model).toBe("auto")
    expect(body.stream).toBe(false)
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Is there an error banner?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ])
  })

  test("a file path becomes a data URL; a relative path resolves from the directory", async () => {
    await fs.writeFile(path.join(dir, "shot.png"), Buffer.from(PNG_BASE64, "base64"))
    const seen: string[] = []
    const image = await resolveVisionImage("shot.png", dir, async (file) => {
      seen.push(file)
    })
    expect(image.url).toBe(`data:image/png;base64,${PNG_BASE64}`)
    expect(seen).toEqual([path.join(dir, "shot.png")])
  })

  test("data and http(s) URLs pass through; bad input is refused with a clear reason", async () => {
    expect((await resolveVisionImage("data:image/png;base64,AAA", dir)).url).toBe("data:image/png;base64,AAA")
    expect((await resolveVisionImage("https://example.test/a.png", dir)).url).toBe("https://example.test/a.png")
    await expect(resolveVisionImage("notes.txt", dir)).rejects.toThrow("Not a supported image file")
    await expect(resolveVisionImage("missing.png", dir)).rejects.toThrow("Image file not found")
    await expect(resolveVisionImage("  ", dir)).rejects.toThrow("No image given")
  })

  test("a refused permission stops the file from being read", async () => {
    await fs.writeFile(path.join(dir, "shot.png"), Buffer.from(PNG_BASE64, "base64"))
    await expect(
      resolveVisionImage(path.join(dir, "shot.png"), "/elsewhere", async () => {
        throw new Error("denied")
      }),
    ).rejects.toThrow("denied")
  })

  test("isInsideDir", () => {
    expect(isInsideDir(path.join(dir, "a", "b.png"), dir)).toBe(true)
    expect(isInsideDir(dir, dir)).toBe(true)
    expect(isInsideDir(path.join(dir, "..", "x.png"), dir)).toBe(false)
  })

  test("sends the credential, privacy tier and question, and returns the answer and served model", async () => {
    const calls: { url: string; headers: Headers; body: any }[] = []
    const fakeFetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) })
      return new Response(
        JSON.stringify({ model: "qwen-vision", choices: [{ message: { content: " Yes: 'Save failed' " } }] }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const answer = await askSynapseVision({
      target: { baseURL: "https://synapse.test/v1/", headers: { "x-extra": "1" } },
      token: "tok",
      imageUrl: "data:image/png;base64,AAA",
      question: "Is there an error banner?",
      privacyTier: "local-only",
      fetch: fakeFetch,
    })
    expect(answer).toEqual({ text: "Yes: 'Save failed'", servedModel: "qwen-vision" })
    expect(calls[0].url).toBe("https://synapse.test/v1/chat/completions")
    expect(calls[0].headers.get("authorization")).toBe("Bearer tok")
    expect(calls[0].headers.get("x-privacy-tier")).toBe("local-only")
    expect(calls[0].headers.get("x-extra")).toBe("1")
    expect(calls[0].body.messages[0].content[0].text).toBe("Is there an error banner?")
  })

  test("a base URL without /v1 gets it added; no token sends no credential header", async () => {
    let seen: { url: string; headers: Headers } | undefined
    const fakeFetch = (async (url: any, init: any) => {
      seen = { url: String(url), headers: new Headers(init.headers) }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    }) as unknown as typeof fetch
    await askSynapseVision({
      target: { baseURL: "https://synapse.test", headers: {} },
      imageUrl: "data:image/png;base64,AAA",
      question: "q",
      fetch: fakeFetch,
    })
    expect(seen?.url).toBe("https://synapse.test/v1/chat/completions")
    expect(seen?.headers.has("authorization")).toBe(false)
  })

  test("an HTTP error or an empty answer is reported, not hidden", async () => {
    const reply = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    const base = { target: { baseURL: "https://s.test/v1", headers: {} }, imageUrl: "x", question: "q" }
    await expect(askSynapseVision({ ...base, fetch: reply(502, { error: "gpu down" }) })).rejects.toThrow("HTTP 502")
    await expect(
      askSynapseVision({ ...base, fetch: reply(200, { choices: [{ message: { content: "" } }] }) }),
    ).rejects.toThrow("empty answer")
    const noVision = { error: { message: "No available model can serve this request's required capability: image input" } }
    await expect(askSynapseVision({ ...base, fetch: reply(404, noVision) })).rejects.toThrow(
      "Synapse has no vision model available right now",
    )
  })

  test("an image is saved once by content hash and the note names the file and the tool", async () => {
    const first = await saveImageForVision(`data:image/png;base64,${PNG_BASE64}`, "image/png", dir)
    const again = await saveImageForVision(PNG_BASE64, "image/png", dir)
    expect(first).toBe(again)
    expect(first!.endsWith(".png")).toBe(true)
    expect((await fs.readFile(first!)).toString("base64")).toBe(PNG_BASE64)
    expect(await fs.readdir(dir)).toHaveLength(1)
    expect(await saveImageForVision("https://example.test/a.png", "image/png", dir)).toBe("https://example.test/a.png")
    const note = visionNote(first!, "shot.png")
    expect(note).toContain(`image="${first}"`)
    expect(note).toContain("synapse_vision")
  })

  test("a text-only Synapse model gets a note instead of the image when no vision_proxy is set", async () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "what does the page show?" },
          { type: "file", mediaType: "image/png", data: PNG_BASE64, filename: "page.png" },
        ],
      },
    ] as unknown as ModelMessage[]
    const model = { providerID: "synapse", capabilities: { input: { image: false } } } as any
    markSynapseVisionReady(true)
    const result = await proxyUnsupportedImages(msgs, model, undefined, undefined, undefined)
    const parts = (result[0] as any).content
    expect(parts[0]).toEqual({ type: "text", text: "what does the page show?" })
    expect(parts[1].type).toBe("text")
    expect(parts[1].text).toContain('[Image "page.png" available at: ')
    expect(parts[1].text).toContain("synapse_vision")
  })

  test("a model that can see images, or a setup where the tool cannot run, is left alone", async () => {
    const msgs = [
      { role: "user", content: [{ type: "image", image: new Uint8Array([1, 2, 3]) }] },
    ] as unknown as ModelMessage[]
    const seeing = { providerID: "synapse", capabilities: { input: { image: true } } } as any
    const textOnly = { providerID: "synapse", capabilities: { input: { image: false } } } as any
    markSynapseVisionReady(true)
    expect(await proxyUnsupportedImages(msgs, seeing, undefined, undefined, undefined)).toBe(msgs)
    markSynapseVisionReady(false)
    expect(await proxyUnsupportedImages(msgs, textOnly, undefined, undefined, { provider: {} })).toBe(msgs)
  })
})
