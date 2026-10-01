// The Keystone services the box may use (owner decision 2026-10-01, review R4-01): only chosen
// connections, picked at runtime. Each id is a Keystone connection reached at /mcp/c/<id>; the box
// never gets /mcp/dynamic, which would relay to every service on the owner's account (m365 mail,
// monday execute_code, ...).
//
// The box-wide set is saved in the bridge home (keystone.json) by oc_server_restart {keystone}, so
// later bridges and restarts reuse it. Without a saved set the config default applies. The set is
// read on every use (never cached per bridge): one bridge may change it while others run.
//
// Ids are NOT checked against Keystone here. A wrong id simply fails to connect, and oc_doctor shows it.
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { DelegateError } from "./errors.ts"

/** A Keystone connection id: lower-case, digits and `-`, 1-63 characters, no leading `-`. */
export const CONNECTION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
/**
 * The owner's default set: company knowledge base (read-only), GitHub, Seq logs.
 * `rag-read` (issue #56) is a private Keystone connection over the `rag-read` MCP service, whose
 * tool policy is an allowlist of read tools, so ingest, delete, contribute and feedback are refused
 * by Keystone itself, even for an admin owner and even with a token taken from the box.
 */
export const DEFAULT_KEYSTONE = ["rag-read", "github", "seqlogs"] as const
/** Bounded so the generated policy regex and front config stay small. */
export const MAX_CONNECTIONS = 20
export const KEYSTONE_FILE = "keystone.json"

export type KeystoneSource = "saved" | "default"
export type KeystoneSet = { connections: string[]; source: KeystoneSource }

/** The profile entry name for a connection id. */
export const entryName = (id: string) => `ks-${id}`

/** The connection id of a `ks-<id>` entry name, or undefined when the name is not one. */
export function idOfEntry(name: string): string | undefined {
  if (!name.startsWith("ks-")) return undefined
  const id = name.slice(3)
  return CONNECTION_ID.test(id) ? id : undefined
}

/**
 * Validated, de-duplicated ids, in the given order. Throws invalid_input naming the first bad id
 * (cut to 40 characters: the value came from a caller).
 */
export function keystoneIds(ids: readonly unknown[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    if (typeof id !== "string" || !CONNECTION_ID.test(id))
      throw new DelegateError("invalid_input", `"${String(id).slice(0, 40)}" is not a valid Keystone connection id.`, "Use lower-case letters, digits and '-' (1-63 characters), for example rag-read.")
    if (!out.includes(id)) out.push(id)
  }
  if (out.length > MAX_CONNECTIONS)
    throw new DelegateError("invalid_input", `At most ${MAX_CONNECTIONS} Keystone connections can be chosen.`, "Choose fewer connections.")
  return out
}

/** Regex metacharacters escaped. Valid ids have none; this keeps a future id rule change from widening the pattern. */
export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

/** `^/mcp/c/(a|b)$` for the ids; undefined for none, so nothing at all can match. */
export function connectionPathPattern(ids: readonly string[]): string | undefined {
  if (ids.length === 0) return undefined
  return `^/mcp/c/(${keystoneIds(ids).map(escapeRegExp).join("|")})$`
}

const keystoneFile = (home: string) => path.join(home, KEYSTONE_FILE)

function damaged(home: string, why: string): DelegateError {
  return new DelegateError(
    "profile_invalid",
    "The saved Keystone service choice in the bridge home is damaged, so nothing was started.",
    "Call oc_server_restart with confirm: true and keystone: [...] to choose the services again.",
    `${why}: ${keystoneFile(home)}`,
  )
}

/** The box-wide set: the saved one, else `fallback` (config.keystoneConnections). A damaged file fails closed. */
export function readKeystoneSet(home: string, fallback: readonly string[]): KeystoneSet {
  let raw: string
  try {
    raw = readFileSync(keystoneFile(home), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { connections: keystoneIds(fallback), source: "default" }
    throw damaged(home, `unreadable (${(error as NodeJS.ErrnoException).code ?? "error"})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw damaged(home, "not JSON")
  }
  const list = (parsed as { connections?: unknown } | null)?.connections
  if (!Array.isArray(list)) throw damaged(home, "no connections list")
  try {
    return { connections: keystoneIds(list), source: "saved" }
  } catch {
    throw damaged(home, "invalid connection id")
  }
}

/** Save the box-wide set (temp file + rename, so a reader never sees half a file). */
export function saveKeystoneSet(home: string, ids: readonly string[]): string[] {
  const connections = keystoneIds(ids)
  const file = keystoneFile(home)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(tmp, JSON.stringify({ connections }, null, 2) + "\n", "utf8")
    renameSync(tmp, file)
  } catch (error) {
    throw new DelegateError("sandbox_unavailable", "The bridge could not save the Keystone service choice.", "Check the bridge home folder (OPENCODE_DELEGATE_HOME) is writable, then retry.", `${(error as NodeJS.ErrnoException).code ?? "error"} ${file}`)
  }
  return connections
}
