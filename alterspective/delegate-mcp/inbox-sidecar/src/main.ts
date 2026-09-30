// FEAT-OCD-001 MOD-05: inbox sidecar entry point. Env:
//   INBOX_ADMIN_TOKEN (required, >= 32 chars; set per box start by the bridge, never logged)
//   INBOX_PORT (default 8080), INBOX_DATA_DIR (default /data, a named volume)
// Logs are JSON lines on stdout and never contain message text or the token.
import { MIN_ADMIN_TOKEN_LENGTH } from "./rules.ts"
import { createHandler, type LogLine } from "./server.ts"
import { InboxStore } from "./store.ts"

export const MAX_REQUEST_BODY = 64 * 1024

export function stdoutLog(line: LogLine): void {
  try {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: "opencode-delegate-inbox", ...line }) + "\n")
  } catch {
    // a broken stdout must not break a request
  }
}

export type Started = { port: number; stop: () => void; store: InboxStore }

export function startFromEnv(env: Record<string, string | undefined>, log = stdoutLog): Started {
  const token = env.INBOX_ADMIN_TOKEN ?? ""
  if (token.length < MIN_ADMIN_TOKEN_LENGTH) throw new Error(`INBOX_ADMIN_TOKEN is missing or shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters.`)
  const port = Number(env.INBOX_PORT ?? "8080")
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("INBOX_PORT is not a port number.")
  const store = InboxStore.open({ dir: env.INBOX_DATA_DIR ?? "/data" })
  const server = Bun.serve({ port, hostname: env.INBOX_HOST ?? "0.0.0.0", maxRequestBodySize: MAX_REQUEST_BODY, fetch: createHandler({ store, adminToken: token, log }) })
  log({ level: "info", event: "started", port: server.port ?? port, lastId: store.lastId, skippedLines: store.skippedLines })
  return {
    port: server.port ?? port,
    store,
    stop: () => {
      void server.stop(true)
      store.close()
    },
  }
}

if (import.meta.main) {
  try {
    startFromEnv(process.env)
  } catch (error) {
    stdoutLog({ level: "error", event: "start_failed", detail: error instanceof Error ? error.message : "unknown" })
    process.exit(1)
  }
}
