// #73: one delegated task's record, keyed by session key. Metadata only: never a prompt, an answer,
// file contents or an error body (prompts may hold client data; WEBSTA-001-SECRETS-MANAGEMENT-STANDARDS).
// Records are read back from a folder several bridges share, so every field is validated on read
// and anything unknown or malformed is dropped.
import { AGENT_RE, MODEL_RE, SESSION_ID_RE, SESSION_KEY } from "../supervisor/workspaces-state.ts"

export const RECORD_VERSION = 1

export type Outcome = "running" | "completed" | "error" | "aborted" | "unknown"
export type Disposition = "open" | "collected" | "closed_clean" | "closed_discarded" | "swept"
export type Tokens = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

export type TaskRecord = {
  v: typeof RECORD_VERSION
  sessionID: string
  key: string
  /** OPENCODE_DELEGATE_NAME of the bridge that started the task. */
  bridge: string
  /** The owner repo's folder name only, never the full path. */
  repo: string
  agent?: string
  /** The model last sent (`synapse/<id>` since #71). */
  requestedModel?: string
  /** The model the sandbox reports it answered with (assistant message providerID/modelID). */
  servedModel?: string
  startedAt: string
  sendCount: number
  firstSendAt?: string
  lastSendAt?: string
  finishedAt?: string
  outcome: Outcome
  /** First send to the latest finish. */
  durationMs?: number
  /** A short bridge label for an error outcome, never an error body. */
  errorCode?: string
  /** Summed over the assistant messages oc_result read (a lower bound for long sessions). */
  tokens?: Tokens
  commitsCollected?: number
  collected: boolean
  disposition: Disposition
  closedAt?: string
}

export const OUTCOMES: readonly Outcome[] = ["running", "completed", "error", "aborted", "unknown"]
export const DISPOSITIONS: readonly Disposition[] = ["open", "collected", "closed_clean", "closed_discarded", "swept"]

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const BRIDGE_RE = /^[a-z0-9-]{1,40}$/
/** A folder name: printable, no separators. */
const REPO_RE = /^[^\\/\u0000-\u001f\u007f]{1,128}$/
export const ERROR_CODE_RE = /^[A-Za-z0-9 _.:-]{1,60}$/

/** The owner repo's folder name (Windows or POSIX path), or "(unknown)". */
export function repoName(hostRepo: string): string {
  const name = hostRepo.split(/[\\/]+/).filter(Boolean).pop() ?? ""
  return REPO_RE.test(name) ? name : "(unknown)"
}

export function newTaskRecord(input: { sessionID: string; key: string; bridge: string; repo: string; startedAt: string; agent?: string; requestedModel?: string }): TaskRecord {
  return {
    v: RECORD_VERSION,
    sessionID: input.sessionID,
    key: input.key,
    bridge: input.bridge,
    repo: input.repo,
    ...(input.agent && AGENT_RE.test(input.agent) ? { agent: input.agent } : {}),
    ...(input.requestedModel && MODEL_RE.test(input.requestedModel) ? { requestedModel: input.requestedModel } : {}),
    startedAt: input.startedAt,
    sendCount: 0,
    outcome: "unknown",
    collected: false,
    disposition: "open",
  }
}

const str = (v: unknown, re: RegExp): string | undefined => (typeof v === "string" && re.test(v) ? v : undefined)
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined)
const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed as readonly unknown[]).includes(v) ? (v as T) : undefined

function tokens(v: unknown): Tokens | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const t = v as Record<string, unknown>
  return { input: count(t.input) ?? 0, output: count(t.output) ?? 0, reasoning: count(t.reasoning) ?? 0, cacheRead: count(t.cacheRead) ?? 0, cacheWrite: count(t.cacheWrite) ?? 0 }
}

/** A record from disk, validated field by field; undefined when a required field is missing or bad. */
export function parseTaskRecord(raw: string): TaskRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const p = parsed as Record<string, unknown>
  const sessionID = str(p.sessionID, SESSION_ID_RE)
  const key = str(p.key, SESSION_KEY)
  const bridge = str(p.bridge, BRIDGE_RE)
  const repo = str(p.repo, REPO_RE)
  const startedAt = str(p.startedAt, ISO_RE)
  const outcome = pick(p.outcome, OUTCOMES)
  const disposition = pick(p.disposition, DISPOSITIONS)
  if (p.v !== RECORD_VERSION || !sessionID || !key || !bridge || !repo || !startedAt || !outcome || !disposition) return undefined
  const optional = {
    agent: str(p.agent, AGENT_RE),
    requestedModel: str(p.requestedModel, MODEL_RE),
    servedModel: str(p.servedModel, MODEL_RE),
    firstSendAt: str(p.firstSendAt, ISO_RE),
    lastSendAt: str(p.lastSendAt, ISO_RE),
    finishedAt: str(p.finishedAt, ISO_RE),
    durationMs: count(p.durationMs),
    errorCode: str(p.errorCode, ERROR_CODE_RE),
    tokens: tokens(p.tokens),
    commitsCollected: count(p.commitsCollected),
    closedAt: str(p.closedAt, ISO_RE),
  }
  const record: TaskRecord = { v: RECORD_VERSION, sessionID, key, bridge, repo, startedAt, sendCount: count(p.sendCount) ?? 0, outcome, collected: p.collected === true, disposition }
  for (const [name, value] of Object.entries(optional)) if (value !== undefined) (record as Record<string, unknown>)[name] = value
  return record
}
