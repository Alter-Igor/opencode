// MOD-01 T1.1: build the box's read-only OpenCode profile (technical-design.md §3.1).
// Only provider.synapse, model and small_model are taken from the owner's global config; every
// value that could be a secret must be an {env:NAME} reference whose NAME is on config.boxEnv.
// Values are never copied into errors or logs — only the key path is named (ERR-MSG-03, ASR-04).
//
// #71 (owner requirement, unconditional): Synapse is the box's only provider
// (`enabled_providers: ["synapse"]`), it offers only the models registered in Synapse, and the
// default is synapse/auto. Every other owner provider is dropped and reported. The registered
// list is read on the host at box start (src/synapse/models.ts) and written to MODELS_FILE, which
// OpenCode merges after opencode.json. MODELS_FILE is outside the profile hash: a model added or
// retired in Synapse never makes a running box "stale" (profile_changed); the box offers the list
// it was started with until its next start. What the owner asks for (model, small_model, per-model
// name / limit / modalities) is hashed, in MODELS_REQUEST_FILE, so changing it still reports
// profile_changed (review cycle 1).
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { BridgeConfig } from "../shared/config.ts"
import type { Guard, McpEntry } from "../shared/contracts.ts"
import { CONNECTION_ID, entryName } from "../shared/keystone.ts"
import { validateEntries } from "../guard/entries.ts"
import { keystoneHostAuth } from "../guard/egress-identity.ts"
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { SYNAPSE_HOST } from "../synapse/auth-conf.ts"
import { AUTO_MODEL, FALLBACK_MODELS, type ModelLimit, type RegisteredModels } from "../synapse/models.ts"
import { MODEL_RE } from "./workspaces-state.ts"
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
  /** #67: host-held Keystone tokens (entries carry oauth:false). Default: OCD_KEYSTONE_HOST_AUTH=1. */
  hostAuth?: boolean
  /** Supplied by MOD-02 (Guard.permissionBaseline); the supervisor does not decide policy. */
  permission: PermissionRule[]
  /** provider id → env name to use as options.apiKey when the owner's entry has no key (must be on boxEnv). */
  keyEnv?: Record<string, string>
  /**
   * WS2 (#48): providers whose credential `front` sets (the owner's delegated Synapse token). Their
   * own key and auth headers are removed before the scan, and options.apiKey becomes a fixed,
   * non-secret placeholder (front drops whatever the box sends). The box holds no key for them.
   */
  frontAuth?: string[]
  /** OpenCode custom tools (file name → source) for opencode/tool/. Default: profileTools(). */
  tools?: Record<string, string>
  /** #71: the models registered in Synapse (src/synapse/models.ts). Default: `auto` only. */
  synapseModels?: SynapseModels
}

export type SynapseModels = Pick<RegisteredModels, "models" | "limits">

type Dropped = Array<{ provider: string; reason: string }>

/** #71: what the models file is made from: the owner's requested defaults and per-model settings (already scanned). */
export type ModelRequest = { model?: Json; small_model?: Json; settings: JsonObject }

export type BuiltProfile = {
  /** Paths relative to the profile root (mounted at /profile, XDG_CONFIG_HOME). */
  files: Record<string, string>
  /** Covers every file except MODELS_FILE (#71). */
  hash: string
  providers: string[]
  dropped: Dropped
  /** #71: the provider/model ids the box offers. */
  offered: string[]
  /** #71: lets withRegisteredModels re-write MODELS_FILE at box start without the owner config. */
  request: ModelRequest
}

/** #71: the only provider in the box, and its default model. */
export const SYNAPSE_PROVIDER = "synapse"
export const DEFAULT_MODEL = `${SYNAPSE_PROVIDER}/${AUTO_MODEL}`
export const SYNAPSE_BASE_URL = `https://${SYNAPSE_HOST}/v1`
const SYNAPSE_NPM = "@ai-sdk/openai-compatible"
/** #71: OpenCode merges the global opencode.jsonc after opencode.json (config.ts global load order). */
export const MODELS_FILE = "opencode/opencode.jsonc"
/** Review cycle 1: the owner's model request (defaults + per-model settings), inside the hash. Not a config file OpenCode reads. */
export const MODELS_REQUEST_FILE = "opencode/models-request.json"
const MODELS_HEADER = "// Generated by the bridge (#71): the models registered in Synapse when this box started. Outside the profile hash."
const ONLY_SYNAPSE = "only Synapse is enabled in the box"

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

type Providers = { kept: JsonObject; names: string[]; dropped: Dropped; settings: JsonObject }

/**
 * #71: the box's one provider, `synapse`. Its entry starts from the owner's provider.synapse (scanned
 * as before), with the SDK package and base URL fixed and no `models` (those come from Synapse, see
 * renderModels). Every other owner provider is dropped and reported. An owner entry that needs an
 * env outside boxEnv is replaced by the built-in entry, so the box always has Synapse.
 */
export function selectProviders(owner: JsonObject, input: ProfileInput): Providers {
  const allowed = new Set(input.config.boxEnv)
  const out: Providers = { kept: {}, names: [SYNAPSE_PROVIDER], dropped: [], settings: {} }
  const providers = isObject(owner.provider) ? owner.provider : {}
  for (const [id, entry] of Object.entries(providers)) {
    if (!isObject(entry)) throw invalid(`The owner config entry provider.${id} is not an object.`)
    if (id !== SYNAPSE_PROVIDER) out.dropped.push({ provider: id, reason: ONLY_SYNAPSE })
  }
  const front = input.frontAuth?.includes(SYNAPSE_PROVIDER) ?? false
  let entry = isObject(providers[SYNAPSE_PROVIDER]) ? providers[SYNAPSE_PROVIDER] : {}
  const own = front ? withoutCredentials(entry) : entry
  const missing = [...scanProvider(own, `provider.${SYNAPSE_PROVIDER}`).envNames].filter((name) => !allowed.has(name))
  if (missing.length) {
    out.dropped.push({ provider: SYNAPSE_PROVIDER, reason: `the owner's Synapse settings need ${missing.sort().join(", ")} (not on the approved box env list); the built-in Synapse entry is used` })
    entry = {}
  }
  out.settings = modelSettings(entry.models)
  const base = synapseEntry(front ? withoutCredentials(entry) : entry)
  out.kept[SYNAPSE_PROVIDER] = front ? withPlaceholderKey(base) : withKeyEnv(SYNAPSE_PROVIDER, base, input.keyEnv?.[SYNAPSE_PROVIDER], allowed)
  return out
}

/**
 * The owner's entry reduced to name and options, with Synapse's SDK package and base URL (review
 * cycle 1: no api / env / id, and no whitelist / blacklist that could hide `auto` or a registered model).
 */
function synapseEntry(entry: JsonObject): JsonObject {
  const options = isObject(entry.options) ? entry.options : {}
  return { npm: SYNAPSE_NPM, name: typeof entry.name === "string" ? entry.name : "Synapse", options: { ...options, baseURL: SYNAPSE_BASE_URL } }
}

/** Per-model keys an owner may set (review cycle 1): never `id`, `provider` or `options`, which could remap a registered name to another upstream model. */
const MODEL_SETTING_KEYS = ["name", "limit", "modalities"] as const

function modelSettings(models: Json | undefined): JsonObject {
  const out: JsonObject = {}
  if (!isObject(models)) return out
  for (const [id, value] of Object.entries(models)) {
    if (!isObject(value)) continue
    const kept: JsonObject = {}
    for (const key of MODEL_SETTING_KEYS) if (value[key] !== undefined) kept[key] = value[key]
    out[id] = kept
  }
  return out
}

/** Not a secret: front replaces the Authorization header the box sends for these providers. */
export const FRONT_AUTH_PLACEHOLDER = "front-sets-this-credential"
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "api-key"])

/** The entry with options.apiKey and credential headers removed (front sets the credential). */
function withoutCredentials(entry: JsonObject): JsonObject {
  const options = isObject(entry.options) ? { ...entry.options } : {}
  delete options.apiKey
  if (isObject(options.headers)) options.headers = Object.fromEntries(Object.entries(options.headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())))
  return { ...entry, options }
}

function withPlaceholderKey(entry: JsonObject): JsonObject {
  return { ...entry, options: { ...(isObject(entry.options) ? entry.options : {}), apiKey: FRONT_AUTH_PLACEHOLDER } }
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
 * #67 step 4: with host-held tokens (`hostAuth`, OCD_KEYSTONE_HOST_AUTH=1) each entry carries
 * `oauth: false`: front adds the credential, and the box never runs a Keystone sign-in.
 */
export function mcpEntries(config: ProfileInput["config"], hostAuth: boolean = keystoneHostAuth()): JsonObject {
  const origin = new URL(config.keystoneOrigin).origin
  const entries: Record<string, McpEntry> = {}
  for (const id of config.keystoneConnections) {
    if (!CONNECTION_ID.test(id)) throw invalid(`The Keystone connection id "${id.slice(0, 40)}" is not valid.`)
    entries[entryName(id)] = hostAuth ? { type: "remote", url: `${origin}/mcp/c/${id}`, oauth: false } : { type: "remote", url: `${origin}/mcp/c/${id}` }
  }
  const verdict = validateEntries(entries, config.keystoneOrigin, config.keystoneConnections, hostAuth)
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

type RenderedModels = { text: string; offered: string[]; dropped: Dropped }

/**
 * #71: MODELS_FILE: the registered models as the synapse provider's models (the owner's per-model
 * settings kept for ids Synapse lists; Synapse's limits win), and model / small_model: the owner's
 * choice when it is a registered synapse/* model, else synapse/auto (reported).
 */
export function renderModels(request: ModelRequest, registered: SynapseModels = { models: [...FALLBACK_MODELS], limits: {} }): RenderedModels {
  const ids = registered.models.includes(AUTO_MODEL) ? registered.models : [AUTO_MODEL, ...registered.models]
  const offered = ids.map((id) => `${SYNAPSE_PROVIDER}/${id}`)
  const models: JsonObject = {}
  for (const id of ids) {
    const own = isObject(request.settings[id]) ? request.settings[id] : {}
    const limit: ModelLimit | undefined = registered.limits[id]
    models[id] = { name: id, ...own, ...(limit ? { limit: { context: limit.context, output: limit.output } } : {}) }
  }
  const dropped: Dropped = []
  const pick = (key: "model" | "small_model"): string => {
    const value = request[key]
    if (value === undefined) return DEFAULT_MODEL
    if (typeof value === "string" && offered.includes(value)) return value
    const shown = typeof value === "string" && MODEL_RE.test(value) ? value : "it"
    dropped.push({ provider: key, reason: `${shown} is not a model registered in Synapse; ${DEFAULT_MODEL} is used` })
    return DEFAULT_MODEL
  }
  const config = { model: pick("model"), small_model: pick("small_model"), provider: { [SYNAPSE_PROVIDER]: { models } } }
  return { text: `${MODELS_HEADER}\n${JSON.stringify(config, null, 2)}\n`, offered, dropped }
}

const isModelDrop = (d: Dropped[number]) => d.provider === "model" || d.provider === "small_model"

/**
 * #71, at box start: the same profile with MODELS_FILE written from the list just read from
 * Synapse. The hash does not change (MODELS_FILE is outside it).
 */
export function withRegisteredModels(built: BuiltProfile, registered: SynapseModels): BuiltProfile {
  const rendered = renderModels(built.request, registered)
  return { ...built, files: { ...built.files, [MODELS_FILE]: rendered.text }, offered: rendered.offered, dropped: [...built.dropped.filter((d) => !isModelDrop(d)), ...rendered.dropped] }
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
    enabled_providers: [SYNAPSE_PROVIDER],
    provider: providers.kept,
    mcp: mcpEntries(input.config, input.hostAuth ?? keystoneHostAuth()),
    permission: permissionConfig(input.permission),
  }
  const request: ModelRequest = { ...(owner.model !== undefined ? { model: owner.model } : {}), ...(owner.small_model !== undefined ? { small_model: owner.small_model } : {}), settings: providers.settings }
  const models = renderModels(request, input.synapseModels)
  const files: Record<string, string> = {
    "opencode/.gitignore": PROFILE_GITIGNORE,
    "opencode/opencode.json": JSON.stringify(config, null, 2) + "\n",
    [MODELS_FILE]: models.text,
    // Review cycle 1: what the owner asked for is hashed (a change still reports profile_changed);
    // only Synapse's own list, in MODELS_FILE, is outside the hash. OpenCode does not load this file.
    [MODELS_REQUEST_FILE]: JSON.stringify(request, null, 2) + "\n",
  }
  for (const [name, source] of Object.entries(input.tools ?? profileTools())) files[`opencode/tool/${name}`] = source
  return { files, hash: hashFiles(files), providers: providers.names, dropped: [...providers.dropped, ...models.dropped], offered: models.offered, request }
}

// ---------- hashing + writing ----------

/** Every file but MODELS_FILE (#71: the registered list may change between starts without making a box stale). */
export function hashFiles(files: Record<string, string>): string {
  const hash = createHash("sha256")
  for (const name of Object.keys(files).sort()) if (name !== MODELS_FILE) hash.update(name).update("\0").update(files[name]!).update("\0")
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
