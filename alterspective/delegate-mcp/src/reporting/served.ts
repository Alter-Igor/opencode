// #76: which model Synapse actually served a delegated session's model calls. OpenCode only knows
// the model it asked for (`synapse/auto` mostly), but Synapse names the routed model in the response
// header `x-synapse-served-model`. front logs that header next to the session id the box's OpenCode
// sends (`x-opencode-session`, set by the fork's Synapse plugin), so the bridge counts them per
// session from front's container log. Metadata only: no URI, no body, no token is logged or read.
//
// The session id is written by the box. The box is one trust zone, so a session could claim
// another's id; that only skews these counts, nothing else reads them. Every field is checked on
// read and anything that does not look exactly right is skipped.
import type { BridgeConfig } from "../shared/config.ts"
import { containerName } from "../supervisor/compose-env.ts"
import type { Exec } from "../supervisor/docker.ts"
import { SESSION_ID_RE } from "../supervisor/workspaces-state.ts"
import { SYNAPSE_HOST } from "../synapse/auth-conf.ts"

/** A served model id as Synapse names it (provider/model, or a bare id); never nginx's "-". */
export const SERVED_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/
/** The most distinct served models kept per task. */
export const MAX_SERVED_MODELS = 20
/**
 * The most log lines read per harvest: the newest ones since the first send. front's log is shared
 * by every session and host, so on a busy box a long task's earliest calls can fall outside it and
 * its counts come out low (CodeRabbit on #126). A later read can raise them (keepServed).
 */
export const MAX_LOG_LINES = 20_000
export const LOG_TIMEOUT_MS = 15_000

export type ServedModels = Record<string, number>

export const frontContainer = (config: Pick<BridgeConfig, "project">) => `${containerName(config)}-front`

/** The two #76 fields at the end of a front log line (nginx.conf `log_format front`). */
const FIELDS_RE = / sess="([^"]*)" served="([^"]*)"$/

/** Count, per served model, the Synapse calls in `log` that carry `sessionID`. */
export function parseServed(log: string, sessionID: string): ServedModels {
  const counts: ServedModels = {}
  if (!SESSION_ID_RE.test(sessionID)) return counts
  for (const line of log.split(/\r?\n/)) {
    if (!line.includes(` host=${SYNAPSE_HOST} `)) continue
    const fields = FIELDS_RE.exec(line)
    if (!fields || fields[1] !== sessionID) continue
    const model = fields[2] ?? ""
    if (!SERVED_MODEL_RE.test(model)) continue
    if (counts[model] === undefined && Object.keys(counts).length >= MAX_SERVED_MODELS) continue
    counts[model] = (counts[model] ?? 0) + 1
  }
  return counts
}

/**
 * The served models for one session since `sinceIso`, from front's log. Undefined when the log
 * cannot be read (front stopped or recreated, Docker down): never an empty count.
 */
export async function servedModelsFromFront(exec: Exec, config: Pick<BridgeConfig, "project">, sessionID: string, sinceIso: string): Promise<ServedModels | undefined> {
  if (Number.isNaN(Date.parse(sinceIso))) return undefined
  const result = await exec(["docker", "logs", "--since", sinceIso, "--tail", String(MAX_LOG_LINES), frontContainer(config)], { timeoutMs: LOG_TIMEOUT_MS }).catch(() => undefined)
  if (!result || result.code !== 0) return undefined
  return parseServed(result.stdout, sessionID)
}

const total = (served: ServedModels | undefined) => Object.values(served ?? {}).reduce((sum, n) => sum + n, 0)

/**
 * The counts to keep: a new read replaces the stored one only when it saw at least as many calls.
 * A read after a box restart sees fewer (front's log starts again), so it never erases what an
 * earlier read counted.
 */
export function keepServed(stored: ServedModels | undefined, read: ServedModels | undefined): ServedModels | undefined {
  if (!read || total(read) === 0) return stored
  return total(read) >= total(stored) ? read : stored
}

/** The model that served most of a task's calls (ties: alphabetical), or undefined. */
export function mainServedModel(served: ServedModels | undefined): string | undefined {
  const entries = Object.entries(served ?? {})
  if (!entries.length) return undefined
  return entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
}
