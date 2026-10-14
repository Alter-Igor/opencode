// #171: a committed image or profile starts a second compose project beside the one that is
// already running. The project name is the base project plus the 12-hex content hash from the
// image tag (identity.ts). A dirty tag (`-dirty-`) never starts a stack. At most two projects run.
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { PROJECT_RE } from "../shared/config.ts"

/** How many compose projects may run at once (the one already up, plus the new one). */
export const GENERATION_CAP = 2

const CONTENT = "[0-9a-f]{12}"
/** `<image>:<version>-<12 hex>` or the same with `-dirty-<12 hex>`. Shorter tags are not generations. */
const IMAGE_TAG = new RegExp(`^(?:[^:]+:)?(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)*?)-(${CONTENT})(?:-dirty-(${CONTENT}))?$`)

export type ImageTag = { version: string; content: string; dirty?: string }

/** The content hash baked into an image tag, or undefined when the tag is not a generation id. */
export function parseImageTag(image: string): ImageTag | undefined {
  const match = IMAGE_TAG.exec(image)
  if (!match?.[1] || !match[2]) return undefined
  return { version: match[1], content: match[2], ...(match[3] ? { dirty: match[3] } : {}) }
}

/**
 * Compose project for this image beside `base`, or undefined when this image must not start one
 * (dirty checkout, tag without a 12-hex content hash, or the name would not fit PROJECT_RE).
 * When `base` is already that generation, the same name is returned.
 */
export function generationProject(base: string, image: string): string | undefined {
  const parsed = parseImageTag(image)
  if (!parsed || parsed.dirty) return undefined
  if (base.endsWith(`-${parsed.content}`)) return base
  const name = `${base}-${parsed.content}`
  if (!PROJECT_RE.test(name)) return undefined
  return name
}

const REGISTRY = "generations.json"

/** Project names this home has started beside the base project. Missing or damaged file: none. */
export async function readGenerations(home: string): Promise<string[]> {
  let raw: string
  try {
    raw = await readFile(path.join(home, REGISTRY), "utf8")
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
  const projects = (parsed as { projects?: unknown }).projects
  if (!Array.isArray(projects)) return []
  return projects.filter((name): name is string => typeof name === "string" && PROJECT_RE.test(name))
}

/** Remember a generation project. The base project is not written here. */
export async function rememberGeneration(home: string, project: string): Promise<void> {
  if (!PROJECT_RE.test(project)) return
  const names = new Set(await readGenerations(home))
  names.add(project)
  await writeFile(path.join(home, REGISTRY), JSON.stringify({ projects: [...names].sort() }) + "\n")
}
