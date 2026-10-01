// WS2 (#48): oc_doctor's view of the owner's Synapse token. States and checks only, never a value.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { Exec } from "../supervisor/docker.ts"
import { AUTH_FILE_NAME, SYNAPSE_HOST, authConfHasToken, authConfPath, isAuthConf } from "./auth-conf.ts"
import { expectedSynapseLocations, locationLines } from "./front-routes.ts"
import { readState, refreshAt, type Reload, type SynapseDeps, type TokenState } from "./token-manager.ts"

export type LiveAuth =
  | {
      shapeOk: boolean
      hasToken: boolean
      /** Review L6: front loaded THIS home's include (same sha256), not another bridge home's. */
      matchesHost: boolean
      /** Review H1: the loaded synapse server has exactly the allowed model routes. */
      routesOk: boolean
    }
  | { unavailable: string }

export type SynapseReport = {
  /**
   * signed_in: a live token is in front. expired: the renewal keeps failing for a passing reason
   * (Keystone down, store read error) and retries with backoff; no model calls meanwhile.
   * needs_sign_in: Keystone refused, or no refresh token is stored: run oc_login {server:"synapse"}.
   * include_empty (review L5): signed in and not expired, but front's include has no token (it was
   * re-created or emptied); the next refresh tick writes it again.
   */
  state: "signed_in" | "needs_sign_in" | "expired" | "include_empty"
  user?: string
  actor?: string
  expiresAt?: string
  refreshAt?: string
  nextRetryAt?: string
  refreshTokenStored: boolean
  /** A rotated refresh token this bridge holds in memory because the store could not save it yet (M1). */
  pendingSave: boolean
  store: string
  lastError?: string
  /** The include on the host: well-formed and carrying a token (never the token). */
  hostFile: { shapeOk: boolean; hasToken: boolean }
  /** Review M3: the last reload of front (front-reload's result) and when. */
  lastReload?: { result: Reload; at: string }
  /**
   * Review M3: front has loaded the include written last: a reload that worked after the write, or
   * front (re)started after it. `nginx -T` alone cannot tell: it reads the files on disk.
   */
  loadedSinceWrite: boolean
  live: LiveAuth
  ok: boolean
}

export async function synapseReport(deps: SynapseDeps, exec: Exec): Promise<SynapseReport> {
  const state = await readState(deps.home)
  const conf = await readFile(authConfPath(deps.frontDir), "utf8").catch(() => "")
  const stored = await deps.store.has()
  const pendingSave = deps.memory.pendingRefresh !== undefined || state?.pendingBy !== undefined
  const hostFile = { shapeOk: isAuthConf(conf), hasToken: authConfHasToken(conf) }
  const needsSignIn = !state || state.needsSignIn === true || (!stored && !pendingSave)
  const kind = needsSignIn ? "needs_sign_in" : deps.now() >= state.expiresAt ? "expired" : !hostFile.hasToken ? "include_empty" : "signed_in"
  const live = await liveAuth(exec, deps.frontContainer, conf)
  const liveOk = !("unavailable" in live) && live.shapeOk && live.hasToken && live.matchesHost && live.routesOk
  const loadedSinceWrite = loadedAfterWrite(state, await frontStartedAt(exec, deps.frontContainer))
  return {
    state: kind,
    ...(state?.user ? { user: state.user } : {}),
    ...(state?.actor ? { actor: state.actor } : {}),
    ...(state && state.expiresAt > 0 ? { expiresAt: new Date(state.expiresAt).toISOString(), refreshAt: new Date(refreshAt(state, deps.refreshFraction)).toISOString() } : {}),
    ...(state?.retryAt ? { nextRetryAt: new Date(state.retryAt).toISOString() } : {}),
    refreshTokenStored: stored,
    pendingSave,
    store: deps.store.kind,
    ...(state?.lastError ? { lastError: state.lastError } : {}),
    hostFile,
    ...(state?.lastReload ? { lastReload: { result: state.lastReload.result, at: new Date(state.lastReload.at).toISOString() } } : {}),
    loadedSinceWrite,
    live,
    ok: kind === "signed_in" && hostFile.shapeOk && liveOk && loadedSinceWrite,
  }
}

/**
 * The include written last is loaded when a reload worked after that write, or front started after
 * it. A state from before review M3 has no `includeAt`; its adopt time stands in (the write it made).
 */
export function loadedAfterWrite(state: TokenState | undefined, startedAt: number | undefined): boolean {
  const writtenAt = state?.includeAt ?? state?.obtainedAt
  if (state === undefined || writtenAt === undefined) return false
  const reloaded = state.lastReload?.result === "reloaded" && state.lastReload.at >= writtenAt
  return reloaded || (startedAt !== undefined && startedAt >= writtenAt)
}

/** When front's container last started (Docker's clock), or undefined when it cannot be read. */
export async function frontStartedAt(exec: Exec, container: string): Promise<number | undefined> {
  const run = await exec(["docker", "inspect", "--type", "container", "--format", "{{.State.StartedAt}}", container], { timeoutMs: 20_000 })
  if (run.code !== 0) return undefined
  // Docker prints nanoseconds; Date.parse wants at most milliseconds.
  const at = Date.parse(run.stdout.trim().replace(/(\.\d{3})\d+/, "$1"))
  return Number.isFinite(at) && at > 0 ? at : undefined
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const HEADER = (file: string) => `# configuration file ${file}:\n`

/** One file's text in an `nginx -T` dump (nginx prints each file, then one newline). */
export function dumpSection(dump: string, file: string): string | undefined {
  const at = dump.indexOf(HEADER(file))
  if (at === -1) return undefined
  const start = at + HEADER(file).length
  const next = dump.indexOf("\n# configuration file ", start)
  return next === -1 ? dump.slice(start).replace(/\n$/, "") : dump.slice(start, next)
}

/** The synapse server block in the loaded servers.conf. */
function synapseServer(servers: string): string | undefined {
  return [...servers.matchAll(/^server \{\n([\s\S]*?)\n\}$/gm)].map((m) => m[1] ?? "").find((body) => body.includes(`    server_name ${SYNAPSE_HOST};`))
}

/** The include and the synapse routes as front LOADED them. The include text never leaves this function. */
export async function liveAuth(exec: Exec, container: string, hostConf: string): Promise<LiveAuth> {
  const dump = await exec(["docker", "exec", container, "nginx", "-T"], { timeoutMs: 20_000 })
  if (dump.code !== 0) return { unavailable: "front is not running, or `nginx -T` failed" }
  const text = dump.stdout.replaceAll("\r\n", "\n")
  const section = dumpSection(text, `/etc/nginx/front-gen/${AUTH_FILE_NAME}`)
  if (section === undefined) return { unavailable: `front has not loaded ${AUTH_FILE_NAME}` }
  const server = synapseServer(dumpSection(text, "/etc/nginx/front-gen/servers.conf") ?? "")
  const routesOk = server !== undefined && JSON.stringify(locationLines(server)) === JSON.stringify(expectedSynapseLocations())
  return { shapeOk: isAuthConf(section), hasToken: authConfHasToken(section), matchesHost: sha(section) === sha(hostConf), routesOk }
}
