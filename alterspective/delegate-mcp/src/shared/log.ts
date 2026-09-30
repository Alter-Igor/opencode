// Structured JSON logs to stderr and a daily file (LOGGING-STANDARDS required fields).
// stdout carries the MCP protocol, so nothing here may write to it (deviation D-1 from OBS-SNK-01).
import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"

export type Level = "debug" | "info" | "warn" | "error"

type Fields = Record<string, string | number | boolean | undefined>

const SECRET_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|cookie/i
const REDACTED = "[redacted]"

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

/** Replace secret-shaped substrings of `text`. Commit ids (40 hex) are redacted too: fail closed. */
export function scrub(text: string): string {
  return text
    .replace(SCHEME, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(PREFIXED, REDACTED)
    .replace(JWT, REDACTED)
    .replace(HEX, REDACTED)
    .replace(B64_RUN, (run) => (looksRandom(run) ? REDACTED : run))
}

export type Logger = {
  log(level: Level, component: string, msg: string, fields?: Fields): void
}

export function redact(fields: Fields): Fields {
  const out: Fields = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : typeof value === "string" ? scrub(value) : value
  }
  return out
}

export function createLogger(options: { dir?: string; minLevel?: Level; write?: (line: string) => void } = {}): Logger {
  const order: Level[] = ["debug", "info", "warn", "error"]
  const min = order.indexOf(options.minLevel ?? "info")
  const write = options.write ?? ((line: string) => process.stderr.write(line + "\n"))
  if (options.dir) mkdirSync(options.dir, { recursive: true })
  return {
    log(level, component, msg, fields = {}) {
      if (order.indexOf(level) < min) return
      const ts = new Date().toISOString()
      const line = JSON.stringify({ ts, level, service: "opencode-delegate", component, msg: scrub(msg), ...redact(fields) })
      write(line)
      if (options.dir) appendFileSync(path.join(options.dir, `bridge-${ts.slice(0, 10)}.log`), line + "\n")
    },
  }
}

export const silentLogger: Logger = { log() {} }
