// MOD-01 T1.1: build the box's read-only OpenCode profile (technical-design.md §3.1).
// Only provider/model/small_model are taken from the owner's global config; every value that
// could be a secret must be an {env:NAME} reference whose NAME is on config.boxEnv. Values are
// never copied into errors or logs — only the key path is named (ERR-MSG-03, ASR-04).
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { BridgeConfig } from "../shared/config.ts"
import type { Guard, McpEntry } from "../shared/contracts.ts"
import { CONNECTION_ID, entryName } from "../shared/keystone.ts"
import { validateEntries } from "../guard/entries.ts"
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { invalid, scanProvider, type Json, type JsonObject } from "./profile-scan.ts"

export { scanProvider } from "./profile-scan.ts"

export type PermissionRule = ReturnType<Guard["permissionBaseline"]>[number]

/** Written because OpenCode crashes writing it into a read-only config dir (config.ts:309-325). */
export const PROFILE_GITIGNORE = ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n") + "\n"

export type ProfileInput = {
  /** Owner config files in load order (config.json, opencode.json, opencode.jsonc); JSONC allowed. */
  ownerConfigs: string[]
  /** keystoneConnections must be the effective set (shared/config.ts effectiveConfig). */
  config: Pick<BridgeConfig, "keystoneOrigin" | "keystoneConnections" | "boxEnv">
  /** Supplied by MOD-02 (Guard.permissionBaseline); the supervisor does not decide policy. */
  permission: PermissionRule[]
  /** provider id → env name to use as options.apiKey when the owner's entry has no key (must be on boxEnv). */
  keyEnv?: Record<string, string>
  /** OpenCode custom tools (file name → source) for opencode/tool/. Default: profileTools(). */
  tools?: Record<string, string>
}

export type BuiltProfile = {
  /** Paths relative to the profile root (mounted at /profile, XDG_CONFIG_HOME). */
  files: Record<string, string>
  hash: string
  providers: string[]
  dropped: Array<{ provider: string; reason: string }>
}

/**
 * MOD-05 in-box inbox tools (profile-tools/). They are copied into opencode/tool/ so OpenCode
 * loads them from the read-only profile and the profile hash covers them (review M2).
 */
export const PROFILE_TOOL_FILES = ["inbox-lib.ts", "message_supervisor.ts", "message_session.ts", "read_inbox.ts"] as const
const PROFILE_TOOLS_DIR = path.join(import.meta.dir, "..", "..", "profile-tools")
let toolSources: Record<string, string> | undefined

/** Sources of the profile tools, read once. A missing file fails closed (profile_invalid). */
export function profileTools(): Record<string, string> {
  if (toolSources) return toolSources
  const out: Record<string, string> = {}
  for (const name of PROFILE_TOOL_FILES) {
    try {
      out[name] = readFileSync(path.join(PROFILE_TOOLS_DIR, name), "utf8")
    } catch {
      throw invalid(`The bridge's profile tool ${name} is missing from this checkout.`)
    }
  }
  toolSources = out
  return out
}

// ---------- JSONC ----------

/** Remove // and /* *\/ comments and trailing commas outside strings. */
export function stripJsonc(text: string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '"') {
      const end = stringEnd(text, i)
      out += text.slice(i, end)
      i = end
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      out += ch
      i++
    }
  }
  return removeTrailingCommas(out)
}

function stringEnd(text: string, start: number): number {
  let i = start + 1
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1
  return Math.min(i + 1, text.length)
}

function removeTrailingCommas(text: string): string {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '"') {
      const end = stringEnd(text, i)
      out += text.slice(i, end)
      i = end - 1
      continue
    }
    if (ch === ",") {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (text[j] === "}" || text[j] === "]") continue
    }
    out += ch
  }
  return out
}

export function parseOwnerConfig(text: string, label: string): JsonObject {
  let value: unknown
  try {
    value = JSON.parse(stripJsonc(text))
  } catch {
    throw invalid(`The owner OpenCode config (${label}) is not valid JSON/JSONC.`)
  }
  if (!isObject(value)) throw invalid(`The owner OpenCode config (${label}) is not a JSON object.`)
  return value
}

// ---------- building ----------

type Providers = { kept: JsonObject; names: string[]; dropped: BuiltProfile["dropped"] }

export function selectProviders(owner: JsonObject, input: ProfileInput): Providers {
  const allowed = new Set(input.config.boxEnv)
  const out: Providers = { kept: {}, names: [], dropped: [] }
  const providers = isObject(owner.provider) ? owner.provider : {}
  for (const [id, entry] of Object.entries(providers)) {
    if (!isObject(entry)) throw invalid(`The owner config entry provider.${id} is not an object.`)
    const scan = scanProvider(entry, `provider.${id}`)
    const missing = [...scan.envNames].filter((name) => !allowed.has(name))
    if (missing.length) {
      out.dropped.push({ provider: id, reason: `needs ${missing.sort().join(", ")} (not on the approved box env list)` })
      continue
    }
    out.kept[id] = withKeyEnv(id, entry, input.keyEnv?.[id], allowed)
    out.names.push(id)
  }
  return out
}

function withKeyEnv(id: string, entry: JsonObject, envName: string | undefined, allowed: Set<string>): JsonObject {
  if (!envName) return entry
  if (!allowed.has(envName)) throw invalid(`The key env for provider ${id} is not on the approved box env list.`)
  const options = isObject(entry.options) ? entry.options : {}
  if (typeof options.apiKey === "string" && options.apiKey !== "") return entry
  return { ...entry, options: { ...options, apiKey: `{env:${envName}}` } }
}

/**
 * One `ks-<id>` → `/mcp/c/<id>` entry per chosen Keystone connection, and nothing else (review
 * R4-01: never /mcp/dynamic, which reaches every service on the owner's account). The result is
 * checked by the guard's profile-time allowlist, so a bad entry can never reach the box.
 */
export function mcpEntries(config: ProfileInput["config"]): JsonObject {
  const origin = new URL(config.keystoneOrigin).origin
  const entries: Record<string, McpEntry> = {}
  for (const id of config.keystoneConnections) {
    if (!CONNECTION_ID.test(id)) throw invalid(`The Keystone connection id "${id.slice(0, 40)}" is not valid.`)
    entries[entryName(id)] = { type: "remote", url: `${origin}/mcp/c/${id}` }
  }
  const verdict = validateEntries(entries, config.keystoneOrigin, config.keystoneConnections)
  if (!verdict.ok) throw invalid(`The box's Keystone MCP entries failed the allowlist: ${verdict.reason.slice(0, 200)}`)
  return entries as JsonObject
}

/** Rules → OpenCode config shape, preserving rule order (OpenCode evaluates last match wins). */
export function permissionConfig(rules: PermissionRule[]): JsonObject {
  const grouped = new Map<string, Array<[string, string]>>()
  for (const rule of rules) {
    const list = grouped.get(rule.permission) ?? []
    list.push([rule.pattern, rule.action])
    grouped.set(rule.permission, list)
  }
  const out: JsonObject = {}
  for (const [permission, list] of grouped) {
    const only = list.length === 1 ? list[0] : undefined
    out[permission] = only && only[0] === "*" ? only[1] : Object.fromEntries(list)
  }
  return out
}

function modelFields(owner: JsonObject, providers: Providers): JsonObject {
  const out: JsonObject = {}
  const usable = (model: Json | undefined) => typeof model === "string" && providers.names.includes(model.split("/")[0] ?? "")
  if (owner.model !== undefined) {
    if (!usable(owner.model)) throw invalid("The owner's default model uses a provider that is not available in the box.")
    out.model = owner.model
  }
  if (owner.small_model !== undefined && usable(owner.small_model)) out.small_model = owner.small_model
  else if (owner.small_model !== undefined) providers.dropped.push({ provider: "small_model", reason: "its provider is not available in the box" })
  return out
}

/** Objects merge key by key (later file wins per leaf); arrays and scalars are replaced, as OpenCode's own merge does (A-21). */
export function mergeDeep(base: JsonObject, over: JsonObject): JsonObject {
  const out: JsonObject = { ...base }
  for (const [key, value] of Object.entries(over)) {
    const current = out[key]
    out[key] = isObject(current) && isObject(value) ? mergeDeep(current, value) : value
  }
  return out
}

export function mergeOwnerConfigs(texts: string[]): JsonObject {
  const merged: JsonObject = {}
  texts.forEach((text, index) => {
    const parsed = parseOwnerConfig(text, `file ${index + 1}`)
    for (const key of ["model", "small_model"] as const) if (parsed[key] !== undefined) merged[key] = parsed[key]
    if (isObject(parsed.provider)) merged.provider = mergeDeep(isObject(merged.provider) ? merged.provider : {}, parsed.provider)
  })
  return merged
}

/** Pure: the whole profile as a file map plus its hash. Nothing is written. */
export function buildProfile(input: ProfileInput): BuiltProfile {
  const owner = mergeOwnerConfigs(input.ownerConfigs)
  const providers = selectProviders(owner, input)
  const config: JsonObject = {
    $schema: "https://opencode.ai/config.json",
    ...modelFields(owner, providers),
    provider: providers.kept,
    mcp: mcpEntries(input.config),
    permission: permissionConfig(input.permission),
  }
  const files: Record<string, string> = {
    "opencode/.gitignore": PROFILE_GITIGNORE,
    "opencode/opencode.json": JSON.stringify(config, null, 2) + "\n",
  }
  for (const [name, source] of Object.entries(input.tools ?? profileTools())) files[`opencode/tool/${name}`] = source
  return { files, hash: hashFiles(files), providers: providers.names, dropped: providers.dropped }
}

// ---------- hashing + writing ----------

export function hashFiles(files: Record<string, string>): string {
  const hash = createHash("sha256")
  for (const name of Object.keys(files).sort()) hash.update(name).update("\0").update(files[name]!).update("\0")
  return hash.digest("hex")
}

export type ProfileFs = {
  readText(file: string): Promise<string | undefined>
  writeText(file: string, text: string): Promise<void>
  /** Relative file paths (forward slashes) under root, recursively; [] if root is missing. */
  listFiles(root: string): Promise<string[]>
  remove(file: string): Promise<void>
}

export async function hashDirectory(fs: ProfileFs, root: string): Promise<string> {
  const files: Record<string, string> = {}
  for (const name of await fs.listFiles(root)) files[name] = (await fs.readText(path.join(root, name))) ?? ""
  return hashFiles(files)
}

/** Replace the profile directory contents with `files`; returns the hash of what is on disk. */
export async function writeProfile(fs: ProfileFs, root: string, files: Record<string, string>): Promise<string> {
  for (const stale of await fs.listFiles(root)) if (!(stale in files)) await fs.remove(path.join(root, stale))
  for (const [name, text] of Object.entries(files)) await fs.writeText(path.join(root, name), text)
  return hashDirectory(fs, root)
}

/** Owner config files in OpenCode's global load order; missing ones are skipped. */
export async function readOwnerConfigs(fs: Pick<ProfileFs, "readText">, dir: string): Promise<string[]> {
  const texts: string[] = []
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    const text = await fs.readText(path.join(dir, name))
    if (text !== undefined) texts.push(text)
  }
  return texts
}

/** Filesystem failure → DelegateError; the path and errno go to `detail` only (A-07). */
export function fsFailure(what: string, error: unknown, file: string): DelegateError {
  if (isDelegateError(error)) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown"
  return new DelegateError("sandbox_unavailable", `The bridge could not ${what}.`, "Check the bridge home folder and ~/.config/opencode are readable and writable, then run oc_doctor.", `${code} ${file}`)
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

export const nodeProfileFs: ProfileFs = {
  // Only a missing file is "absent"; an unreadable one fails closed instead of being skipped.
  readText: (file) => readFile(file, "utf8").catch((error: unknown) => {
    if (missing(error)) return undefined
    throw fsFailure("read an OpenCode config or profile file", error, file)
  }),
  async writeText(file, text) {
    try {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, text, "utf8")
    } catch (error) {
      throw fsFailure("write the sandbox profile", error, file)
    }
  },
  async listFiles(root) {
    const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch((error: unknown) => {
      if (missing(error)) return []
      throw fsFailure("list the sandbox profile folder", error, root)
    })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
  },
  remove: (file) => rm(file, { force: true }).catch((error: unknown) => {
    throw fsFailure("clean the sandbox profile folder", error, file)
  }),
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
