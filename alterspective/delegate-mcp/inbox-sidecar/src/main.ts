// FEAT-OCD-001 MOD-05: inbox sidecar entry point. Env:
//   INBOX_ADMIN_TOKEN (required, >= 32 chars; set per box start by the bridge, never logged)
//   INBOX_PORT (default 8080) and INBOX_HOST (default 0.0.0.0): the box listener
//   INBOX_ADMIN_PORT (default 8081) and INBOX_ADMIN_HOST (default 127.0.0.1): the admin listener.
//     Compose sets INBOX_ADMIN_HOST to `inbox-admin`, an alias that exists only on the `admin`
//     network, so the admin listener is bound to that network's address and the box (on `sealed`
//     only) has no route to it (W2C-05).
//   INBOX_BOX_HOSTNAME (default inbox): the Host name box clients use.
//   INBOX_ADMIN_PUBLIC_PORT (default: the admin port): the 127.0.0.1 port the gate publishes, so
//     the admin listener accepts Host 127.0.0.1:<that port> (W2C-13).
//   INBOX_DATA_DIR (default /data, a named volume)
// Logs are JSON lines on stdout and never contain message text or the token.
import { MIN_ADMIN_TOKEN_LENGTH } from "./rules.ts"
import { createHandlers, type Handlers, type LogLine } from "./server.ts"
import { InboxStore } from "./store.ts"

export const MAX_REQUEST_BODY = 64 * 1024

export function stdoutLog(line: LogLine): void {
  try {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: "opencode-delegate-inbox", ...line }) + "\n")
  } catch {
    // a broken stdout must not break a request
  }
}

export type Started = { port: number; adminPort: number; stop: () => void; store: InboxStore }

type Env = Record<string, string | undefined>

function portFrom(env: Env, name: string, fallback: string): number {
  const port = Number(env[name] ?? fallback)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${name} is not a port number.`)
  return port
}

/** Host headers each listener accepts, from the ports the listeners actually got. */
function hostsFor(env: Env, boxPort: number, adminPort: number): { boxHosts: string[]; adminHosts: string[] } {
  const publicPort = env.INBOX_ADMIN_PUBLIC_PORT ? portFrom(env, "INBOX_ADMIN_PUBLIC_PORT", "0") : adminPort
  const boxName = env.INBOX_BOX_HOSTNAME ?? "inbox"
  const adminName = env.INBOX_ADMIN_HOST ?? "127.0.0.1"
  return {
    boxHosts: [`${boxName}:${boxPort}`],
    adminHosts: [`127.0.0.1:${publicPort}`, `${adminName}:${adminPort}`, `inbox:${adminPort}`],
  }
}

export function startFromEnv(env: Env, log = stdoutLog): Started {
  const token = env.INBOX_ADMIN_TOKEN ?? ""
  if (token.length < MIN_ADMIN_TOKEN_LENGTH) throw new Error(`INBOX_ADMIN_TOKEN is missing or shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters.`)
  const boxPort = portFrom(env, "INBOX_PORT", "8080")
  const adminPort = portFrom(env, "INBOX_ADMIN_PORT", "8081")
  const store = InboxStore.open({ dir: env.INBOX_DATA_DIR ?? "/data" })
  let handlers: Handlers | undefined
  const unready = () => new Response("", { status: 503 })
  const box = Bun.serve({ port: boxPort, hostname: env.INBOX_HOST ?? "0.0.0.0", maxRequestBodySize: MAX_REQUEST_BODY, fetch: (r) => handlers?.box(r) ?? unready() })
  const admin = Bun.serve({ port: adminPort, hostname: env.INBOX_ADMIN_HOST ?? "127.0.0.1", maxRequestBodySize: MAX_REQUEST_BODY, fetch: (r) => handlers?.admin(r) ?? unready() })
  const ports = { box: box.port ?? boxPort, admin: admin.port ?? adminPort }
  handlers = createHandlers({ store, adminToken: token, log, ...hostsFor(env, ports.box, ports.admin) })
  log({ level: "info", event: "started", port: ports.box, adminPort: ports.admin, lastId: store.lastId, skippedLines: store.skippedLines, newEpoch: store.newEpoch })
  return {
    port: ports.box,
    adminPort: ports.admin,
    store,
    stop: () => {
      handlers?.stop()
      void box.stop(true)
      void admin.stop(true)
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
