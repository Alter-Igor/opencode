import * as fs from "fs/promises"
import * as path from "path"
import { createHash } from "crypto"
import { Global } from "@opencode-ai/core/global"

/**
 * #193: Synapse vision as the eyes of a text-only model. A session or sub-agent pinned to a
 * text-only model cannot see an image, and only `synapse/auto` routes an image turn to a vision
 * model. The `synapse_vision` tool sends one image plus a question to Synapse (`model: "auto"`,
 * same sign-in and privacy tier as chat) and returns the answer as text.
 */
export const SYNAPSE_VISION_TOOL = "synapse_vision"
export const SYNAPSE_VISION_MODEL = "auto"
export const SYNAPSE_VISION_MAX_BYTES = 20 * 1024 * 1024
export const SYNAPSE_VISION_TIMEOUT_MS = 120_000
/** Vision models on Synapse may reason first; a small budget leaves the answer empty. */
export const SYNAPSE_VISION_MAX_TOKENS = 4000
/** Saved images older than this are deleted the first time an image is saved in a process. */
export const SYNAPSE_VISION_KEEP_MS = 7 * 24 * 60 * 60 * 1000

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
}

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
}

export interface SynapseVisionTarget {
  baseURL: string
  headers: Record<string, string>
}

/** An image the tool can send: a data URL or an http(s) URL, and a label for messages. */
export interface ResolvedImage {
  url: string
  label: string
}

/**
 * Turn the tool's `image` argument into something Synapse accepts. A data URL or http(s) URL
 * is passed through; anything else is a file path, relative to `directory` when not absolute.
 */
export async function resolveVisionImage(
  image: string,
  directory: string,
  /** Runs before a file is read, e.g. to ask permission for a path outside the project. */
  beforeRead?: (file: string) => Promise<void>,
): Promise<ResolvedImage> {
  const value = image.trim().replace(/^["']|["']$/g, "")
  if (!value) throw new Error("No image given. Pass a file path, a data: URL, or an http(s) URL.")
  if (/^data:image\/[^;,]+;base64,./.test(value)) return { url: value, label: "data URL" }
  if (value.startsWith("data:")) throw new Error("Only base64 image data URLs are supported (data:image/...;base64,...).")
  if (/^https?:\/\//i.test(value)) return { url: value, label: value }

  const file = value.replace(/^file:\/\/\/?/i, "")
  const target = path.isAbsolute(file) ? file : path.join(directory || process.cwd(), file)
  const type = IMAGE_TYPES[path.extname(target).toLowerCase()]
  if (!type) throw new Error(`Not a supported image file: ${target}. Use .png, .jpg, .jpeg, .gif, .webp or .bmp.`)
  const stat = await fs.stat(target).catch(() => undefined)
  if (!stat?.isFile()) throw new Error(`Image file not found: ${target}`)
  if (stat.size > SYNAPSE_VISION_MAX_BYTES) {
    throw new Error(`Image is too large (${stat.size} bytes). The limit is ${SYNAPSE_VISION_MAX_BYTES} bytes.`)
  }
  await beforeRead?.(target)
  const bytes = await fs.readFile(target)
  return { url: `data:${type};base64,${bytes.toString("base64")}`, label: target }
}

/** Where images a text-only model cannot see are saved for the tool (see saveImageForVision). */
export function visionImageDir(): string {
  return path.join(Global.Path.tmp, "vision")
}

/** The OpenAI-shape request: the question first, then the image, in one user message. */
export function synapseVisionBody(input: { imageUrl: string; question: string; model?: string }) {
  return {
    model: input.model || SYNAPSE_VISION_MODEL,
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: input.question },
          { type: "image_url" as const, image_url: { url: input.imageUrl } },
        ],
      },
    ],
    max_tokens: SYNAPSE_VISION_MAX_TOKENS,
    stream: false,
  }
}

function chatCompletionsUrl(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, "")
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`
}

export interface SynapseVisionAnswer {
  text: string
  servedModel?: string
}

/**
 * POST the request to Synapse. Credential headers match the chat and `/models` paths. With no
 * token (the delegate box) the request still goes out and the front proxy adds the credential.
 */
export async function askSynapseVision(input: {
  target: SynapseVisionTarget
  token?: string
  imageUrl: string
  question: string
  model?: string
  privacyTier?: string
  userAgent?: string
  fetch?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<SynapseVisionAnswer> {
  const headers = new Headers(input.target.headers)
  headers.set("content-type", "application/json")
  headers.set("accept", "application/json")
  headers.set("x-task-type", "general")
  if (input.userAgent) headers.set("user-agent", input.userAgent)
  if (input.token) {
    headers.set("authorization", `Bearer ${input.token}`)
    headers.set("x-api-key", input.token)
  }
  if (input.privacyTier) headers.set("x-privacy-tier", input.privacyTier)

  const timeout = AbortSignal.timeout(input.timeoutMs ?? SYNAPSE_VISION_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  const response = await (input.fetch ?? fetch)(chatCompletionsUrl(input.target.baseURL), {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify(synapseVisionBody(input)),
  })
  const raw = await response.text().catch(() => "")
  if (!response.ok) {
    // Synapse routes an image only to a model registered with the `vision` op; when none is up
    // it answers 404. Say that plainly so the agent waits or asks, instead of guessing.
    if (response.status === 404 && /image input|"vision"/i.test(raw)) {
      throw new Error(
        `Synapse has no vision model available right now, so the image cannot be looked at. Try again later, or ask the user to describe it. Do not guess what it shows. (HTTP 404 ${raw.slice(0, 300)})`,
      )
    }
    throw new Error(`Synapse vision call failed: HTTP ${response.status} ${raw.slice(0, 500)}`.trim())
  }
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error("Synapse vision call returned a reply that is not JSON.")
  }
  const content = data?.choices?.[0]?.message?.content
  const text = typeof content === "string" ? content.trim() : ""
  if (!text) throw new Error("Synapse vision returned an empty answer. Try a more specific question.")
  return { text, servedModel: typeof data?.model === "string" ? data.model : undefined }
}

/** Decode a data URL or bare base64 string to bytes and a media type, or undefined. */
function imageBytes(value: string, mediaType: string): { bytes: Buffer; mediaType: string } | undefined {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/s)
  const base64 = match ? match[2] : value
  const bytes = Buffer.from(base64, "base64")
  if (bytes.length === 0) return undefined
  return { bytes, mediaType: match ? match[1] : mediaType }
}

const swept = new Set<string>()

/** Best effort: delete saved images older than `keepMs`. Errors are ignored. */
async function sweepOldImages(dir: string, keepMs: number): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const cutoff = Date.now() - keepMs
  await Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name)
      const stat = await fs.stat(file).catch(() => undefined)
      if (stat?.isFile() && stat.mtimeMs < cutoff) await fs.rm(file, { force: true }).catch(() => undefined)
    }),
  )
}

/**
 * Save an image a text-only model cannot see, so the agent can pass the path to
 * `synapse_vision`. Named by content hash: the same image on every step reuses one file.
 * The folder and files are private to the user (they may be client-confidential screenshots),
 * and files older than SYNAPSE_VISION_KEEP_MS are deleted once per process.
 * Returns the path, the URL itself for an http(s) image, or undefined when the image is empty,
 * not a type the tool accepts (e.g. SVG), or larger than SYNAPSE_VISION_MAX_BYTES.
 */
export async function saveImageForVision(
  value: string,
  mediaType = "image/png",
  dir: string = visionImageDir(),
  keepMs: number = SYNAPSE_VISION_KEEP_MS,
): Promise<string | undefined> {
  if (/^https?:\/\//i.test(value)) return value
  const decoded = imageBytes(value, mediaType)
  if (!decoded || decoded.bytes.length > SYNAPSE_VISION_MAX_BYTES) return undefined
  const ext = EXTENSIONS[decoded.mediaType.toLowerCase()]
  if (!ext) return undefined
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  if (!swept.has(dir)) {
    swept.add(dir)
    await sweepOldImages(dir, keepMs)
  }
  const file = path.join(dir, createHash("sha256").update(decoded.bytes).digest("hex").slice(0, 32) + ext)
  const exists = await fs.stat(file).then(
    (stat) => stat.size === decoded.bytes.length,
    () => false,
  )
  if (!exists) {
    // Write then rename, so a concurrent step never reads a half-written file.
    const partial = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(partial, decoded.bytes, { mode: 0o600 })
    await fs.rename(partial, file).catch(async (error) => {
      await fs.rm(partial, { force: true }).catch(() => undefined)
      if (!(await fs.stat(file).catch(() => undefined))) throw error
    })
  }
  return file
}

/** The text that replaces an image part for a text-only model. */
export function visionNote(location: string, name?: string): string {
  return [
    `[Image${name ? ` "${name}"` : ""} available at: ${location}]`,
    `You cannot see images with the current model. To look at this image, call the ${SYNAPSE_VISION_TOOL} tool`,
    `with image="${location}" and a question saying exactly what to look for. Do not guess what the image shows.`,
  ].join("\n")
}
