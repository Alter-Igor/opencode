import type { ModelMessage } from "ai"
import type * as Provider from "./provider"
import { SYNAPSE_VISION_TOOL, saveImageForVision, visionNote } from "@/plugin/synapse-vision"
import { synapseAllowed } from "@/plugin/synapse-models"

export interface VisionProxyConfig {
  model: string
  prompt?: string
  apiKey?: string
  baseURL?: string
}

const DEFAULT_VISION_PROMPT =
  "Describe this image in detail for a text-only AI model. Include all visible text (exact wording, including error messages, labels, buttons), layout and structure, colours and visual styling, any data or numbers visible, and the apparent context. Be thorough — omit nothing visible."

const DEFAULT_VISION_BASE_URL = "https://openrouter.ai/api"

interface ImageLike {
  type: string
  image?: unknown
  /**
   * AI SDK `LanguageModelV3FilePart` carries its payload on `data`. The
   * middleware that calls us runs after `convertToLanguageModelPrompt`, so
   * this — not `image`/`url` — is the shape we actually see at runtime.
   */
  data?: unknown
  url?: unknown
  mediaType?: string
  filename?: string
}

function toBase64DataUrl(data: Uint8Array | ArrayBuffer | Buffer, mimeType = "image/png"): string {
  const bytes: Uint8Array = data instanceof ArrayBuffer ? new Uint8Array(data) : data
  let binary = ""
  const len = bytes.byteLength
  const chunk = 0x8000
  for (let i = 0; i < len; i += chunk) {
    const slice = bytes instanceof Uint8Array
      ? bytes.subarray(i, Math.min(i + chunk, len))
      : (bytes as Buffer).subarray(i, Math.min(i + chunk, len))
    binary += String.fromCharCode(...slice)
  }
  const base64 = typeof btoa !== "undefined" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64")
  return `data:${mimeType};base64,${base64}`
}

function toDataUrl(value: unknown, mediaType = "image/png"): string | null {
  if (typeof value === "string") {
    if (value.startsWith("data:")) return value
    if (value.startsWith("http://") || value.startsWith("https://")) return value
    return `data:${mediaType};base64,${value}`
  }
  if (value instanceof URL) {
    const urlStr = value.toString()
    return urlStr
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return toBase64DataUrl(value, mediaType)
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return toBase64DataUrl(value, mediaType)
  }
  if (ArrayBuffer.isView(value)) {
    // Any view (Uint8Array, Buffer, DataView, ...) - normalise to a byte range
    // over its own buffer rather than casting the view itself.
    return toBase64DataUrl(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), mediaType)
  }
  return null
}

function extractImageData(part: ImageLike): string | null {
  if (part.type === "image") {
    return toDataUrl(part.image, part.mediaType ?? "image/png")
  }

  if (part.type === "file" && part.mediaType?.startsWith("image/")) {
    // `data` is the AI SDK v5 field; `url` is kept for callers that hand us
    // already-normalised parts (and for our own older tests).
    return toDataUrl(part.data ?? part.url, part.mediaType)
  }

  return null
}

function getVisionProxyConfig(
  providerOptions: Record<string, unknown> | undefined,
  globalConfig: { provider?: Record<string, { options?: Record<string, unknown> }> } | undefined,
): VisionProxyConfig | null {
  // Check provider-level config first
  const providerRaw = providerOptions?.vision_proxy
  if (providerRaw && typeof providerRaw === "object") {
    const cfg = providerRaw as VisionProxyConfig
    if (cfg.model && typeof cfg.model === "string") {
      return { ...cfg, prompt: cfg.prompt || DEFAULT_VISION_PROMPT }
    }
  }

  // Fall back: scan all providers for a vision_proxy config
  if (globalConfig?.provider) {
    for (const [, provider] of Object.entries(globalConfig.provider)) {
      const raw = provider?.options?.vision_proxy
      if (raw && typeof raw === "object") {
        const cfg = raw as VisionProxyConfig
        if (cfg.model && typeof cfg.model === "string") {
          return { ...cfg, prompt: cfg.prompt || DEFAULT_VISION_PROMPT }
        }
      }
    }
  }

  return null
}

async function describeImage(
  imageDataUrl: string,
  proxyConfig: VisionProxyConfig,
): Promise<string | null> {
  if (!imageDataUrl) return null

  const baseURL = proxyConfig.baseURL || DEFAULT_VISION_BASE_URL
  const apiKey = proxyConfig.apiKey || ""
  if (!apiKey) return null

  const url = baseURL.endsWith("/v1")
    ? `${baseURL}/chat/completions`
    : baseURL.endsWith("/")
      ? `${baseURL}v1/chat/completions`
      : `${baseURL}/v1/chat/completions`

  const body = {
    model: proxyConfig.model,
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: proxyConfig.prompt! },
          { type: "image_url" as const, image_url: { url: imageDataUrl } },
        ],
      },
    ],
    max_tokens: 2000,
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText)
    return `[Vision proxy error: ${resp.status} ${text}]`
  }

  const data = await resp.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === "string" && content.length > 0) return content
  return null
}

export async function proxyUnsupportedImages(
  msgs: ModelMessage[],
  model: Provider.Model,
  providerOptions: Record<string, unknown> | undefined,
  providerInfo: { api?: { url?: string }; options?: { apiKey?: string; baseURL?: string } } | undefined,
  globalConfig: { provider?: Record<string, { options?: Record<string, unknown> }> } | undefined,
  /** Tool names this request offers the model; the note is only added when synapse_vision is one. */
  toolNames?: Iterable<string>,
): Promise<ModelMessage[]> {
  if (model.capabilities.input.image) return msgs

  const proxyConfig = getVisionProxyConfig(providerOptions, globalConfig)
  // #193: with no vision_proxy configured, a Synapse user gets the image as a saved file and a
  // note to ask the synapse_vision tool about it, instead of an error the model cannot act on.
  const synapseEyes =
    !proxyConfig &&
    Boolean(globalConfig?.provider?.synapse) &&
    synapseAllowed(globalConfig as Parameters<typeof synapseAllowed>[0]) &&
    new Set(toolNames ?? []).has(SYNAPSE_VISION_TOOL)
  if (!proxyConfig && !synapseEyes) return msgs

  // If the proxy config doesn't include its own apiKey, try the provider's
  if (proxyConfig && !proxyConfig.apiKey && providerInfo?.options?.apiKey) {
    proxyConfig.apiKey = providerInfo.options.apiKey
  }

  /** The text that stands in for one image the model cannot see. */
  async function imageText(imageData: string, mediaType?: string, filename?: string): Promise<string> {
    if (!proxyConfig) {
      const location = await saveImageForVision(imageData, mediaType).catch(() => undefined)
      return location
        ? visionNote(location, filename)
        : "[An image was provided but could not be prepared for the synapse_vision tool (empty, an unsupported type such as SVG, or larger than 20 MB). Tell the user; do not guess what it shows.]"
    }
    const description = await describeImage(toDataUrl(imageData, mediaType) ?? imageData, proxyConfig)
    return description
      ? `[Image description from vision proxy (${proxyConfig.model})]:\n${description}`
      : "[Image was provided but vision proxy could not describe it.]"
  }

  const result: ModelMessage[] = []
  for (const msg of msgs) {
    if (typeof msg.content === "string" || !Array.isArray(msg.content)) {
      result.push(msg)
      continue
    }

    // #235: some SDKs keep a tool's screenshot inside the tool result (message-v2.ts
    // supportsMediaInToolResult), so it never becomes a user part. Swap it here too.
    if (msg.role === "tool") {
      let changed = false
      const content: unknown[] = []
      for (const part of msg.content as unknown[]) {
        const swapped = await swapToolResultImages(part, imageText)
        if (swapped !== part) changed = true
        content.push(swapped)
      }
      result.push(changed ? ({ ...msg, content } as ModelMessage) : msg)
      continue
    }

    if (msg.role !== "user") {
      result.push(msg)
      continue
    }

    const newContent: unknown[] = []
    let hadImages = false
    for (const part of msg.content as unknown[]) {
      const imageLike = part as ImageLike
      const imageData = extractImageData(imageLike)
      if (imageData) {
        hadImages = true
        newContent.push({ type: "text", text: await imageText(imageData, imageLike.mediaType, imageLike.filename) })
      } else {
        newContent.push(part)
      }
    }

    if (hadImages) {
      result.push({ ...msg, content: newContent } as ModelMessage)
    } else {
      result.push(msg)
    }
  }

  return result
}

/**
 * Replace image items inside one tool-result part's `content` output with text. Handles the
 * ModelMessage shape (`media`, as message-v2.ts builds it) and the provider prompt shapes the
 * middleware sees (`image-data`, `file-data` with an image media type). URL and file-id items
 * (`image-url`, `file-url`, `*-file-id`) are left alone: message-v2.ts only puts `data:` media in
 * tool results today. Returns the part itself when nothing changed.
 */
async function swapToolResultImages(
  part: unknown,
  imageText: (data: string, mediaType?: string, filename?: string) => Promise<string>,
): Promise<unknown> {
  const tool = part as { type?: string; output?: { type?: string; value?: unknown } }
  if (tool?.type !== "tool-result" || tool.output?.type !== "content" || !Array.isArray(tool.output.value)) return part
  let changed = false
  const value: unknown[] = []
  for (const item of tool.output.value as Array<Record<string, unknown>>) {
    const kind = item?.type
    const mediaType = typeof item?.mediaType === "string" ? item.mediaType : undefined
    const isImage =
      (kind === "image-data" || ((kind === "media" || kind === "file-data") && mediaType?.startsWith("image/"))) &&
      typeof item.data === "string"
    if (!isImage) {
      value.push(item)
      continue
    }
    changed = true
    const filename = typeof item.filename === "string" ? item.filename : undefined
    value.push({ type: "text", text: await imageText(item.data as string, mediaType ?? "image/png", filename) })
  }
  return changed ? { ...tool, output: { ...tool.output, value } } : part
}
