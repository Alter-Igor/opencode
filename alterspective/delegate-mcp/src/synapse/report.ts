// WS2 (#48): oc_doctor's view of the owner's Synapse token. States and checks only, never a value.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { Exec } from "../supervisor/docker.ts"
import { readFrontGeneration } from "../supervisor/front-generation.ts"
import { SYNAPSE_HOST, authConfHasToken, authConfPath, isAuthConf } from "./auth-conf.ts"
import { expectedSynapseLocations, locationLines } from "./front-routes.ts"
import { readState, refreshAt, type Reload, type SynapseDeps } from "./token-manager.ts"

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
   * A running worker serves the hash of an immutable generation whose include equals this home's.
   * A sent reload signal and `nginx -T` do not establish this.
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
  const loadedSinceWrite = conf !== "" && !("unavailable" in live) && live.matchesHost
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

/** The auth hash a running worker acknowledges, with the immutable file checked against it. */
export async function frontLoadedSha(exec: Exec, container: string): Promise<string | undefined> {
  const generation = await readFrontGeneration(exec, container)
  return generation ? sha(generation.auth) : undefined
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/** The synapse server block in the loaded servers.conf. */
function synapseServer(servers: string): string | undefined {
  return [...servers.matchAll(/^server \{\n([\s\S]*?)\n\}$/gm)].map((m) => m[1] ?? "").find((body) => body.includes(`    server_name ${SYNAPSE_HOST};`))
}

/** Inspect the immutable generation acknowledged by a running worker. Never return its token. */
export async function liveAuth(exec: Exec, container: string, hostConf: string): Promise<LiveAuth> {
  const generation = await readFrontGeneration(exec, container)
  if (!generation) return { unavailable: "front's running worker did not attest a readable, matching generation" }
  const server = synapseServer(generation.servers)
  const routesOk = server !== undefined && JSON.stringify(locationLines(server)) === JSON.stringify(expectedSynapseLocations())
  return { shapeOk: isAuthConf(generation.auth), hasToken: authConfHasToken(generation.auth), matchesHost: sha(generation.auth) === sha(hostConf), routesOk }
}
