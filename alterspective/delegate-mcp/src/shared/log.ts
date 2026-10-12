// Structured JSON logs to stderr and a daily file (LOGGING-STANDARDS required fields).
// stdout carries the MCP protocol, so nothing here may write to it (deviation D-1 from OBS-SNK-01).
// Logging never throws (review A-11): a failing sink loses the line, never the call.
// Daily files are self-cleaning: at the first log of a new day, bridge-<date>.log files older than
// retentionDays (default 30) are deleted. The date comes from the name, not mtime (a restored or
// copied file keeps its day). Foreign names in the folder are never touched.
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs"
import path from "node:path"

export type Level = "debug" | "info" | "warn" | "error"

type Fields = Record<string, string | number | boolean | undefined>

// Field NAMES whose value is always redacted (review N-5). Anchored, so `passed`, `tokens`,
// `bypass` or `tokenCount` are kept. Matches the whole name, a `_`/`-` suffix (client_secret,
// OPENCODE_SERVER_PASSWORD, x-api-key) or a camelCase suffix (accessToken, clientSecret).
const SECRET_WORDS = "password|passwd|secret|token|authorization|api[-_]?key|cookie"
const SECRET_NAME = new RegExp(`^(?:.*[_-])?(?:${SECRET_WORDS})$`, "i")
const SECRET_CAMEL = /[a-z0-9](?:Password|Passwd|Secret|Token|Authorization|Api[-_]?[Kk]ey|Cookie)$/
const REDACTED = "[redacted]"

export function isSecretField(name: string): boolean {
  return SECRET_NAME.test(name) || SECRET_CAMEL.test(name)
}

/**
 * Field names whose value may be a commit id or an image digest (review N-5). In these fields a
 * 40/64-hex run or a `sha256:<hex>` digest is kept; every other secret pattern is still scrubbed.
 */
const ID_FIELDS = new Set(["commit", "base", "sha", "head", "image", "digest", "containerid"])

// Secret-shaped VALUES (review A-24), scrubbed from every string field (incl. `detail`) and `msg`.
// Order matters: schemes first so "Bearer <token>" keeps its scheme word. The credential must hold
// a digit or + / = (every real token does), so prose like "Basic authentication" survives.
const SCHEME = /\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9+/=])[A-Za-z0-9._~+/=-]{8,}/gi
const PREFIXED = /\b(sk|pk|rk|gh[pousr]|gpapp|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g
const JWT = /\beyJ[A-Za-z0-9_-]{5,}(\.[A-Za-z0-9_-]+){0,2}/g
const HEX = /\b[0-9a-fA-F]{32,}\b/g
// Base64/base64url runs of 32+ that look random (a digit, an upper and a lower letter), so long
// plain words and paths such as `/sessions/some-long-session-key` survive.
const B64_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g
const looksRandom = (run: string) => /\d/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run)

/** A git object id (40/64 lower-case hex) or the hex of a `sha256:` digest. */
function isId(run: string, offset: number, text: string): boolean {
  if (text.slice(Math.max(0, offset - 7), offset).toLowerCase() === "sha256:") return true
  return (run.length === 40 || run.length === 64) && run === run.toLowerCase()
}

export type ScrubOptions = { keepIds?: boolean }

/** Replace secret-shaped substrings of `text`. Hex ids are redacted too unless `keepIds`: fail closed. */
export function scrub(text: string, options: ScrubOptions = {}): string {
  return text
    .replace(SCHEME, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(PREFIXED, REDACTED)
    .replace(JWT, REDACTED)
    .replace(HEX, (run: string, offset: number, whole: string) => (options.keepIds && isId(run, offset, whole) ? run : REDACTED))
    .replace(B64_RUN, (run) => (looksRandom(run) ? REDACTED : run))
}

export type Logger = {
  log(level: Level, component: string, msg: string, fields?: Fields): void
}

export function redact(fields: Fields): Fields {
  const out: Fields = {}
  for (const [key, value] of Object.entries(fields)) {
    if (isSecretField(key)) out[key] = REDACTED
    else out[key] = typeof value === "string" ? scrub(value, { keepIds: ID_FIELDS.has(key.toLowerCase()) }) : value
  }
  return out
}

export const LOG_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const BRIDGE_LOG_RE = /^bridge-(\d{4}-\d{2}-\d{2})\.log$/

/** Delete bridge-<date>.log files whose day is before (now - retentionDays), by NAME, keeping everything else. */
function sweepOldLogs(dir: string, now: number, retentionDays: number): void {
  const cutoff = new Date(now - retentionDays * DAY_MS).toISOString().slice(0, 10)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return // an unreadable folder is retried at the next day rollover
  }
  for (const name of names) {
    const day = BRIDGE_LOG_RE.exec(name)?.[1]
    if (day === undefined || day >= cutoff) continue
    try {
      unlinkSync(path.join(dir, name))
    } catch {
      // a locked or vanished file is tried again tomorrow; retention is best effort
    }
  }
}

export function createLogger(options: { dir?: string; minLevel?: Level; write?: (line: string) => void; retentionDays?: number; now?: () => number } = {}): Logger {
  const order: Level[] = ["debug", "info", "warn", "error"]
  const min = order.indexOf(options.minLevel ?? "info")
  const write = options.write ?? ((line: string) => process.stderr.write(line + "\n"))
  const retentionDays = Number.isInteger(options.retentionDays) && (options.retentionDays ?? 0) > 0 ? (options.retentionDays as number) : LOG_RETENTION_DAYS
  const now = options.now ?? (() => Date.now())
  let lastSweptDay: string | undefined
  let fileOk = options.dir !== undefined
  if (options.dir) {
    try {
      mkdirSync(options.dir, { recursive: true })
    } catch {
      fileOk = false // the folder cannot be made: log to stderr only
    }
  }
  return {
    log(level, component, msg, fields = {}) {
      if (order.indexOf(level) < min) return
      let line: string
      try {
        const ts = new Date(now()).toISOString()
        line = JSON.stringify({ ts, level, service: "opencode-delegate", component, msg: scrub(msg), ...redact(fields) })
        if (fileOk && options.dir) {
          const day = ts.slice(0, 10)
          if (day !== lastSweptDay) {
            lastSweptDay = day
            sweepOldLogs(options.dir, now(), retentionDays)
          }
          try {
            appendFileSync(path.join(options.dir, `bridge-${day}.log`), line + "\n")
          } catch {
            // disk full, folder removed, file locked: keep going on stderr
          }
        }
      } catch {
        return
      }
      try {
        write(line)
      } catch {
        // a closed or broken stderr must not break the caller
      }
    },
  }
}

export const silentLogger: Logger = { log() {} }

/** Log through any Logger (an injected one may throw), swallowing what it throws (A-11). */
export function safeLog(logger: Logger, level: Level, component: string, msg: string, fields?: Fields): void {
  try {
    logger.log(level, component, msg, fields)
  } catch {
    // A broken log sink must never change the outcome of a call.
  }
}
