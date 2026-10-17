import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { ModelMessage } from "ai"
import {
  askSynapseVision,
  resolveVisionImage,
  saveImageForVision,
  synapseVisionBody,
  visionNote,
} from "@/plugin/synapse-vision"
import { proxyUnsupportedImages } from "@/provider/vision-proxy"
import { SynapseAuthPlugin } from "@/plugin/synapse"
import { Global } from "@opencode-ai/core/global"
import { pathToFileURL } from "url"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs"

// Windows without the symlink privilege cannot make links; the link tests are then skipped,
// visibly, instead of passing without checking anything.
const canSymlink = (() => {
  const probe = mkdtempSync(path.join(os.tmpdir(), "vision-symlink-probe-"))
  try {
    writeFileSync(path.join(probe, "target"), "x")
    symlinkSync(path.join(probe, "target"), path.join(probe, "link"))
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

describe("synapse_vision (#193)", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-vision-"))
  })

  afterEach(async () => {
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
    expect(seen).toEqual([await fs.realpath(path.join(dir, "shot.png"))])
  })

  test("data and http(s) URLs pass through; bad input is refused with a clear reason", async () => {
    expect((await resolveVisionImage("data:image/png;base64,AAA", dir)).url).toBe("data:image/png;base64,AAA")
    expect((await resolveVisionImage("https://example.test/a.png", dir)).url).toBe("https://example.test/a.png")
    await expect(resolveVisionImage("notes.txt", dir)).rejects.toThrow("Not a supported image file")
    await expect(resolveVisionImage("missing.png", dir)).rejects.toThrow("Image file not found")
    await expect(resolveVisionImage("  ", dir)).rejects.toThrow("No image given")
  })

  test("a file:// URL resolves to the same absolute path (#198)", async () => {
    const file = path.join(dir, "shot.png")
    await fs.writeFile(file, Buffer.from(PNG_BASE64, "base64"))
    const seen: string[] = []
    await resolveVisionImage(pathToFileURL(file).href, "/elsewhere", async (f) => {
      seen.push(f)
    })
    expect(seen).toEqual([await fs.realpath(file)])
  })

  test.skipIf(!canSymlink)("a link is checked at its real target, not at the link (#198)", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vision-link-"))
    try {
      const real = path.join(outside, "secret.png")
      await fs.writeFile(real, Buffer.from(PNG_BASE64, "base64"))
      const link = path.join(dir, "link.png")
      await fs.symlink(real, link)
      const seen: string[] = []
      await resolveVisionImage("link.png", dir, async (f) => {
        seen.push(f)
      })
      expect(seen).toEqual([await fs.realpath(real)])
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  test("a file swapped after the ask is not read (#198)", async () => {
    const file = path.join(dir, "shot.png")
    await fs.writeFile(file, Buffer.from(PNG_BASE64, "base64"))
    await expect(
      resolveVisionImage("shot.png", dir, async (approved) => {
        // Replace the approved file with a different one before the read. The replacement is
        // made while the original still exists, so it cannot reuse the original's inode.
        const replacement = `${approved}.new`
        await fs.writeFile(replacement, Buffer.from(PNG_BASE64, "base64"))
        await fs.rm(approved)
        await fs.rename(replacement, approved)
      }),
    ).rejects.toThrow("changed after it was approved")
  })

  test("a failed write leaves no partial file (#198)", async () => {
    const saveDir = path.join(dir, "readonly")
    await fs.mkdir(saveDir)
    // A folder where the final name should go makes the rename fail on every OS.
    const blocked = await saveImageForVision(PNG_BASE64, "image/png", saveDir)
    await fs.rm(blocked!)
    await fs.mkdir(blocked!)
    await fs.writeFile(path.join(blocked!, "x"), "x")
    await expect(saveImageForVision(PNG_BASE64, "image/png", saveDir)).rejects.toThrow()
    expect((await fs.readdir(saveDir)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("a refused permission stops the file from being read", async () => {
    await fs.writeFile(path.join(dir, "shot.png"), Buffer.from(PNG_BASE64, "base64"))
    await expect(
      resolveVisionImage(path.join(dir, "shot.png"), "/elsewhere", async () => {
        throw new Error("denied")
      }),
    ).rejects.toThrow("denied")
  })

  test("SVG, empty and oversized images are not saved; old saved files are swept", async () => {
    expect(await saveImageForVision("PHN2Zz48L3N2Zz4=", "image/svg+xml", dir)).toBeUndefined()
    expect(await saveImageForVision("", "image/png", dir)).toBeUndefined()
    const big = Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64")
    expect(await saveImageForVision(big, "image/png", dir)).toBeUndefined()
    const sweepDir = path.join(dir, "sweep")
    await fs.mkdir(sweepDir)
    const old = path.join(sweepDir, "old.png")
    await fs.writeFile(old, "x")
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await fs.utimes(old, past, past)
    const saved = await saveImageForVision(PNG_BASE64, "image/png", sweepDir)
    expect(await fs.readdir(sweepDir)).toEqual([path.basename(saved!)])
    if (process.platform !== "win32") expect((await fs.stat(saved!)).mode & 0o777).toBe(0o600)
  })

  test("concurrent saves of one image wait for the sweep and leave one complete file (#198)", async () => {
    const saveDir = path.join(dir, "concurrent")
    const results = await Promise.all(
      Array.from({ length: 8 }, () => saveImageForVision(PNG_BASE64, "image/png", saveDir)),
    )
    expect(new Set(results).size).toBe(1)
    expect(await fs.readdir(saveDir)).toEqual([path.basename(results[0]!)])
    expect((await fs.readFile(results[0]!)).toString("base64")).toBe(PNG_BASE64)
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
    const cfg = { provider: { synapse: {} } }
    const result = await proxyUnsupportedImages(msgs, model, undefined, undefined, cfg, ["read", "synapse_vision"])
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
    const cfg = { provider: { synapse: {} } }
    const tools = ["synapse_vision"]
    expect(await proxyUnsupportedImages(msgs, seeing, undefined, undefined, cfg, tools)).toBe(msgs)
    // No Synapse in this config, or the tool is not offered to this agent: no note.
    expect(await proxyUnsupportedImages(msgs, textOnly, undefined, undefined, { provider: {} }, tools)).toBe(msgs)
    expect(await proxyUnsupportedImages(msgs, textOnly, undefined, undefined, cfg, ["read"])).toBe(msgs)
    const disabled = { ...cfg, disabled_providers: ["synapse"] }
    expect(await proxyUnsupportedImages(msgs, textOnly, undefined, undefined, disabled, tools)).toBe(msgs)
  })
})

describe("synapse_vision tool permissions (#193)", () => {
  const BASE = "https://synapse-vision.example.test/v1"
  const pluginInput = {
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  }
  let project: string
  let outside: string
  const authSeen: (string | null)[] = []
  const realFetch = globalThis.fetch

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), "vision-project-"))
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "vision-outside-"))
    await fs.writeFile(path.join(project, "in.png"), Buffer.from(PNG_BASE64, "base64"))
    await fs.writeFile(path.join(outside, "out.png"), Buffer.from(PNG_BASE64, "base64"))
    const stub = async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
      if (!href.startsWith(BASE)) return realFetch(url, init)
      if (href === `${BASE}/models`) return Response.json({ object: "list", data: [] })
      authSeen.push(new Headers(init?.headers).get("authorization"))
      return Response.json({ model: "vision-1", choices: [{ message: { content: "a red banner" } }] })
    }
    globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect })
    authSeen.length = 0
  })

  afterEach(async () => {
    globalThis.fetch = realFetch
    await fs.rm(project, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  async function visionTool(options: { apiKey?: string } = { apiKey: "k" }) {
    const hooks = await SynapseAuthPlugin(pluginInput, { inferenceUrl: BASE })
    const synapseOptions = { baseURL: BASE, ...(options.apiKey ? { apiKey: options.apiKey } : {}) }
    await hooks.config?.({ provider: { synapse: { options: synapseOptions, models: {} } } } as never)
    return hooks.tool!.synapse_vision
  }

  function context(worktree: string, ask: (input: unknown) => Promise<void>) {
    return {
      sessionID: "s",
      messageID: "m",
      agent: "build",
      directory: project,
      worktree,
      abort: new AbortController().signal,
      metadata() {},
      ask,
    } as never
  }

  test.skipIf(!canSymlink)("a project opened through a link is still inside the project (#198)", async () => {
    const link = `${project}-link`
    await fs.symlink(project, link, "dir")
    try {
      const asked: unknown[] = []
      const tool = await visionTool()
      const ctx = { ...(context("/", async (i) => void asked.push(i)) as object), directory: link } as never
      const out = await tool.execute({ image: "in.png", question: "what?" }, ctx)
      expect(asked).toHaveLength(0)
      expect(out).toContain("a red banner")
    } finally {
      // A folder link on Windows is removed with rmdir; elsewhere unlink removes it.
      await fs.unlink(link).catch(() => fs.rmdir(link)).catch(() => undefined)
    }
  })

  test("a file inside the project is read without asking", async () => {
    const asked: unknown[] = []
    const tool = await visionTool()
    const out = await tool.execute({ image: "in.png", question: "what?" }, context(project, async (i) => {
      asked.push(i)
    }))
    expect(asked).toHaveLength(0)
    expect(out).toContain("a red banner")
  })

  test("a non-git project (worktree '/') still asks before reading a file outside it", async () => {
    const asked: any[] = []
    const tool = await visionTool()
    const out = await tool.execute(
      { image: path.join(outside, "out.png"), question: "what?" },
      context("/", async (i) => {
        asked.push(i)
      }),
    )
    expect(asked).toHaveLength(1)
    expect(asked[0].permission).toBe("external_directory")
    expect(out).toContain("a red banner")
  })

  test("a refused permission stops the tool instead of becoming text", async () => {
    const tool = await visionTool()
    await expect(
      tool.execute(
        { image: path.join(outside, "out.png"), question: "what?" },
        context("/", async () => {
          throw new Error("rejected by user")
        }),
      ),
    ).rejects.toThrow("rejected by user")
  })

  test("credential choice through the tool: stored sign-in first, else the configured apiKey (#198)", async () => {
    const authFile = path.join(Global.Path.data, "auth.json")
    const previous = await fs.readFile(authFile, "utf8").catch(() => undefined)
    try {
      await fs.rm(authFile, { force: true })
      const keyOnly = await visionTool({ apiKey: "configured-key" })
      await keyOnly.execute({ image: "in.png", question: "what?" }, context(project, async () => {}))
      expect(authSeen.at(-1)).toBe("Bearer configured-key")

      await fs.mkdir(Global.Path.data, { recursive: true })
      const expiresAt = String(Date.now() + 60 * 60 * 1000)
      await fs.writeFile(authFile, JSON.stringify({ synapse: { type: "api", key: "stored-token", metadata: { expiresAt } } }))
      const both = await visionTool({ apiKey: "configured-key" })
      await both.execute({ image: "in.png", question: "what?" }, context(project, async () => {}))
      expect(authSeen.at(-1)).toBe("Bearer stored-token")
    } finally {
      if (previous === undefined) await fs.rm(authFile, { force: true })
      else await fs.writeFile(authFile, previous)
    }
  })
})
