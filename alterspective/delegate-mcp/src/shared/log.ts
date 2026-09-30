// Structured JSON logs to stderr and a daily file (LOGGING-STANDARDS required fields).
// stdout carries the MCP protocol, so nothing here may write to it (deviation D-1 from OBS-SNK-01).
import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"

export type Level = "debug" | "info" | "warn" | "error"

type Fields = Record<string, string | number | boolean | undefined>

const SECRET_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|cookie/i

export type Logger = {
  log(level: Level, component: string, msg: string, fields?: Fields): void
}

export function redact(fields: Fields): Fields {
  const out: Fields = {}
  for (const [key, value] of Object.entries(fields)) out[key] = SECRET_KEY.test(key) ? "[redacted]" : value
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
      const line = JSON.stringify({ ts, level, service: "opencode-delegate", component, msg, ...redact(fields) })
      write(line)
      if (options.dir) appendFileSync(path.join(options.dir, `bridge-${ts.slice(0, 10)}.log`), line + "\n")
    },
  }
}

export const silentLogger: Logger = { log() {} }
