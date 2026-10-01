// R5-01: the MCP sign-ins OpenCode keeps in the box (/data/opencode/mcp-auth.json, on the `data`
// volume, so they outlive restarts). An entry that left the chosen Keystone set (for example the
// old `ks-delegate` → /mcp/dynamic) keeps a working refresh token there, and in-box code could copy
// it out through any service that writes. So on every start, reuse and set change the bridge
// removes every entry that is not a current `ks-<id>`.
//
// Why a script and not OpenCode's API: DELETE /mcp/:name/auth answers 404 for a name that is no
// longer in the config (server/routes/instance/httpapi/handlers/mcp.ts authRemove), which is
// exactly the case here. The script takes OpenCode's own lock on the file (core/src/util/
// effect-flock.ts: a mkdir lock at <state>/opencode/locks/<sha1("mcp-auth:" + file)>.lock), so it
// never races a token refresh, then writes a temp file (0600) and renames it over the store.
//
// Why no revocation: Keystone's revocation_endpoint (/api/oauth/revoke) revokes only device-grant
// refresh tokens. For the bridge's tokens (authorization code + DCR client) it answers 200 and
// changes nothing (keystone migration 070 oauth_device_refresh_revoke: `device_grant=TRUE`, NOT
// FOUND → TRUE). Calling it would report a revocation that did not happen. So tokens never leave
// the box: the script prints names, client ids and whether a refresh token was on file, and the
// owner revokes by client id in Keystone (oc_doctor lists them).
//
// The script runs with the box's node (root-owned, read-only image), not bun: bun would read a
// bunfig.toml that in-box code can plant in its home or working folder. Its output is box data.
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { DelegateError } from "../shared/errors.ts"
import type { Exec } from "./docker.ts"

export const AUTH_FILE = "/data/opencode/mcp-auth.json"
export const BOX_NODE = "/usr/local/bin/node"
const WAIT_MS = 10_000
const PRUNED_FILE = "auth-pruned.json"
/** Kept for oc_doctor; older removals drop off. */
const PRUNED_KEEP = 50

// Single quotes only: the script is one docker exec argument, also on Windows.
export const AUTH_SCRIPT = [
  "const fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');",
  "const [mode,file,keepJson,waitText]=process.argv.slice(1);const keep=new Set(JSON.parse(keepJson||'[]'));",
  "const state=process.env.XDG_STATE_HOME||path.join(process.env.HOME||'/home/agent','.local','state');",
  "const lock=path.join(state,'opencode','locks',crypto.createHash('sha1').update('mcp-auth:'+file).digest('hex')+'.lock');",
  "function read(){let raw;try{raw=fs.readFileSync(file,'utf8')}catch(e){if(e.code==='ENOENT')return {};throw e}",
  "const d=JSON.parse(raw);if(!d||typeof d!=='object'||Array.isArray(d))throw new Error('store is not an object');return d}",
  "function sleep(ms){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)}",
  "function acquire(){fs.mkdirSync(path.dirname(lock),{recursive:true});const end=Date.now()+Number(waitText||10000);",
  "for(;;){try{fs.mkdirSync(lock,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()>end)throw new Error('the store lock is held');sleep(100);continue}",
  "fs.writeFileSync(path.join(lock,'heartbeat'),'',{flag:'wx'});",
  "fs.writeFileSync(path.join(lock,'meta.json'),JSON.stringify({token:crypto.randomUUID(),pid:process.pid,hostname:os.hostname(),createdAt:new Date().toISOString()}),{flag:'wx'});return}}",
  "function about(name,v){const o={name,hadRefresh:!!(v&&v.tokens&&v.tokens.refreshToken)};",
  "if(v&&v.clientInfo&&typeof v.clientInfo.clientId==='string')o.clientId=v.clientInfo.clientId;if(v&&typeof v.serverUrl==='string')o.serverUrl=v.serverUrl;return o}",
  "function prune(){let d=read();if(Object.keys(d).every(k=>keep.has(k)))return {names:Object.keys(d),removed:[]};acquire();",
  "try{d=read();const next={},removed=[];for(const [k,v] of Object.entries(d)){if(keep.has(k))next[k]=v;else removed.push(about(k,v))}",
  "const tmp=file+'.prune-'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(next,null,2),{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);",
  "return {names:Object.keys(next),removed}}finally{fs.rmSync(lock,{recursive:true,force:true})}}",
  "try{process.stdout.write(JSON.stringify(mode==='prune'?prune():{names:Object.keys(read()),removed:[]}))}",
  "catch(e){process.stderr.write('auth store: '+String(e&&e.message||e).slice(0,200));process.exit(3)}",
].join("\n")

/** argv for `docker exec <box> ...`. `keep`: the entry names to keep (prune only). */
export function authArgs(mode: "list" | "prune", keep: readonly string[] = [], waitMs = WAIT_MS): string[] {
  return [BOX_NODE, "-e", AUTH_SCRIPT, mode, AUTH_FILE, JSON.stringify(keep), String(waitMs)]
}

export type RemovedEntry = { name: string; clientId?: string; server?: string; hadRefresh: boolean }
export type AuthResult = { names: string[]; unrecognised: number; removed: RemovedEntry[] }

const SAFE_NAME = /^[A-Za-z0-9._-]{1,80}$/
const SAFE_CLIENT = /^[A-Za-z0-9._:-]{1,100}$/
const KEYSTONE_PATH = /^\/mcp\/(dynamic|c\/[a-z0-9][a-z0-9-]{0,62})$/

/** Only Keystone MCP paths are shown; anything else is "other" (the URL is box data). */
function serverOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined
  // A full URL from the box store, or a bare path from our own record.
  const pathname = URL.canParse(url) ? new URL(url).pathname : url
  return KEYSTONE_PATH.test(pathname) ? pathname : "other"
}

function removedOf(raw: unknown): RemovedEntry {
  const value = (raw ?? {}) as { name?: unknown; clientId?: unknown; serverUrl?: unknown; server?: unknown; hadRefresh?: unknown }
  const name = typeof value.name === "string" && SAFE_NAME.test(value.name) ? value.name : "(unrecognised name)"
  const clientId = typeof value.clientId === "string" && SAFE_CLIENT.test(value.clientId) ? value.clientId : undefined
  const server = serverOf(value.serverUrl ?? value.server)
  return { name, ...(clientId ? { clientId } : {}), ...(server ? { server } : {}), hadRefresh: value.hadRefresh === true }
}

/** The script's output, checked. Names that are not plain entry names are counted, never echoed. */
export function parseAuthResult(stdout: string): AuthResult {
  const parsed = JSON.parse(stdout) as { names?: unknown; removed?: unknown }
  if (!Array.isArray(parsed.names) || (parsed.removed !== undefined && !Array.isArray(parsed.removed))) throw new Error("unexpected auth store output")
  const names = parsed.names.filter((name): name is string => typeof name === "string" && SAFE_NAME.test(name))
  return { names, unrecognised: parsed.names.length - names.length, removed: ((parsed.removed as unknown[] | undefined) ?? []).map(removedOf) }
}

function storeFailure(what: string, detail: string): DelegateError {
  return new DelegateError(
    "policy_unverified",
    `The bridge could not ${what} the MCP sign-ins stored in the sandbox, so it is not used: sign-ins for services outside the chosen set might still be there.`,
    "Run oc_doctor, then retry. If it repeats, restart the sandbox with oc_server_restart.",
    detail.slice(0, 300),
  )
}

/** Run the script in the box container; throws policy_unverified on any failure. */
export async function runAuthStore(exec: Exec, container: string, mode: "list" | "prune", keep: readonly string[] = []): Promise<AuthResult> {
  const result = await exec(["docker", "exec", container, ...authArgs(mode, keep)], { timeoutMs: WAIT_MS + 20_000 })
  if (result.code !== 0) throw storeFailure(mode === "prune" ? "clean" : "read", `exit ${result.code}: ${result.stderr.trim()}`)
  try {
    return parseAuthResult(result.stdout.trim())
  } catch (error) {
    throw storeFailure(mode === "prune" ? "clean" : "read", error instanceof Error ? error.message : "unreadable output")
  }
}

export type PrunedRecord = RemovedEntry & { at: string }

/** Removals so far (newest last), from <home>/auth-pruned.json; [] when none or unreadable. */
export function readPruned(home: string): PrunedRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(path.join(home, PRUNED_FILE), "utf8")) as { removed?: unknown }
    return Array.isArray(parsed.removed) ? parsed.removed.map((raw) => ({ ...removedOf(raw), at: String((raw as { at?: unknown }).at ?? "") })) : []
  } catch {
    return []
  }
}

/** Add removals to the record (temp file + rename). Names, client ids and paths only: never a token. */
export function recordPruned(home: string, removed: readonly RemovedEntry[], at: string): void {
  if (removed.length === 0) return
  const all = [...readPruned(home), ...removed.map((entry) => ({ ...entry, at }))].slice(-PRUNED_KEEP)
  const file = path.join(home, PRUNED_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ removed: all }, null, 2) + "\n", "utf8")
  renameSync(tmp, file)
}
