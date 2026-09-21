import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { proxyUnsupportedImages } from "@/provider/vision-proxy"

const textOnlyModel = {
  capabilities: { input: { image: false } },
} as any

const visionModel = {
  capabilities: { input: { image: true } },
} as any

const proxyConfig = { vision_proxy: { model: "google/gemini-2.0-flash-001", apiKey: "test-key" } }

const userWithImage = {
  role: "user",
  content: [
    { type: "text", text: "what is in this image?" },
    { type: "image", image: new Uint8Array([1, 2, 3]) },
  ],
} as unknown as ModelMessage

describe("vision proxy", () => {
  const realFetch = globalThis.fetch
  let calls: { url: string; body: any }[]

  beforeEach(() => {
    calls = []
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function stubFetch(response: Partial<Response>) {
    globalThis.fetch = (async (input: any, init: any) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(init.body) : undefined })
      return response as Response
    }) as typeof fetch
  }

  test("passes through when the model supports image input", async () => {
    const msgs = [userWithImage]
    const result = await proxyUnsupportedImages(msgs, visionModel, proxyConfig, undefined, undefined)
    expect(result).toBe(msgs)
  })

  test("passes through when no vision_proxy config exists", async () => {
    const msgs = [userWithImage]
    const result = await proxyUnsupportedImages(msgs, textOnlyModel, undefined, undefined, undefined)
    expect(result).toBe(msgs)
    const resultGlobal = await proxyUnsupportedImages(msgs, textOnlyModel, undefined, undefined, { provider: {} })
    expect(resultGlobal).toBe(msgs)
  })

  test("replaces image parts with proxy descriptions", async () => {
    stubFetch({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "a detailed description" } }] }),
    } as Partial<Response>)

    const result = await proxyUnsupportedImages([userWithImage], textOnlyModel, proxyConfig, undefined, undefined)

    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(calls[0].body.model).toBe("google/gemini-2.0-flash-001")
    expect(JSON.stringify(calls[0].body)).toContain("data:image/png;base64,")

    const content = (result[0] as any).content
    expect(content[0]).toEqual({ type: "text", text: "what is in this image?" })
    expect(content[1].type).toBe("text")
    expect(content[1].text).toContain("[Image description from vision proxy (google/gemini-2.0-flash-001)]:")
    expect(content[1].text).toContain("a detailed description")
  })

  test("falls back to scanning all providers in global config", async () => {
    stubFetch({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "described" } }] }),
    } as Partial<Response>)

    const globalConfig = { provider: { openrouter: { options: { vision_proxy: { model: "m", apiKey: "k" } } } } }
    const result = await proxyUnsupportedImages([userWithImage], textOnlyModel, undefined, undefined, globalConfig)

    expect(calls.length).toBe(1)
    expect(((result[0] as any).content[1] as any).text).toContain("described")
  })

  test("falls back to the provider apiKey when the proxy config has none", async () => {
    stubFetch({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "described" } }] }),
    } as Partial<Response>)

    const result = await proxyUnsupportedImages(
      [userWithImage],
      textOnlyModel,
      { vision_proxy: { model: "m" } },
      { options: { apiKey: "provider-key" } },
      undefined,
    )

    expect(calls.length).toBe(1)
    expect(((result[0] as any).content[1] as any).text).toContain("described")
  })

  test("inserts an error part instead of throwing when the proxy call fails", async () => {
    stubFetch({ ok: false, status: 500, statusText: "Server Error", text: async () => "boom" } as Partial<Response>)

    const result = await proxyUnsupportedImages([userWithImage], textOnlyModel, proxyConfig, undefined, undefined)

    expect(((result[0] as any).content[1] as any).text).toContain("[Image description from vision proxy")
  })

  test("marks the image undescribable when no api key is available", async () => {
    const result = await proxyUnsupportedImages(
      [userWithImage],
      textOnlyModel,
      { vision_proxy: { model: "m" } },
      undefined,
      undefined,
    )

    expect(calls.length).toBe(0)
    expect(((result[0] as any).content[1] as any).text).toBe("[Image was provided but vision proxy could not describe it.]")
  })

  // Regression: the middleware in session/llm.ts runs AFTER the AI SDK has
  // converted messages into a LanguageModelV3Prompt, where an attached image
  // is `{ type: "file", mediaType, data }` — not `{ type: "image", image }`.
  // The proxy used to read `url`, so pasted images were never described and
  // the transform replaced them with "this model does not support image input".
  test("describes AI SDK file parts that carry the image on `data`", async () => {
    stubFetch({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "a login screen" } }] }),
    } as Partial<Response>)

    const filePartMessage = {
      role: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        { type: "file", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
      ],
    } as unknown as ModelMessage

    const result = await proxyUnsupportedImages([filePartMessage], textOnlyModel, proxyConfig, undefined, undefined)

    expect(calls.length).toBe(1)
    expect(calls[0].body.messages[0].content[1].image_url.url).toStartWith("data:image/png;base64,")
    expect(((result[0] as any).content[1] as any).text).toContain("a login screen")
  })

  test("describes file parts whose data is a base64 string or a URL", async () => {
    stubFetch({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    } as Partial<Response>)

    const message = {
      role: "user",
      content: [
        { type: "file", mediaType: "image/jpeg", data: "AQID" },
        { type: "file", mediaType: "image/png", data: new URL("https://example.com/a.png") },
      ],
    } as unknown as ModelMessage

    await proxyUnsupportedImages([message], textOnlyModel, proxyConfig, undefined, undefined)

    expect(calls.length).toBe(2)
    expect(calls[0].body.messages[0].content[1].image_url.url).toBe("data:image/jpeg;base64,AQID")
    expect(calls[1].body.messages[0].content[1].image_url.url).toBe("https://example.com/a.png")
  })

  test("normalises any ArrayBuffer view (DataView), not just Uint8Array", async () => {
    stubFetch({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    } as Partial<Response>)

    const bytes = new Uint8Array([1, 2, 3])
    const view = new DataView(bytes.buffer, 0, 3)
    const message = {
      role: "user",
      content: [{ type: "file", mediaType: "image/png", data: view }],
    } as unknown as ModelMessage

    await proxyUnsupportedImages([message], textOnlyModel, proxyConfig, undefined, undefined)

    expect(calls.length).toBe(1)
    expect(calls[0].body.messages[0].content[1].image_url.url).toBe("data:image/png;base64,AQID")
  })
})
