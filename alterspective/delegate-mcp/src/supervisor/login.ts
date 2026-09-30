// MOD-01 Keystone sign-in relay for one ks-* entry (technical-design §4 "Keystone sign-in"; proven in spike T0.3).
// The box starts the OAuth flow; the bridge opens the owner's browser, catches the loopback redirect on the
// host, checks `state`, and relays ONLY the code to the box. The code and the URL query are never logged.
import { spawn } from "node:child_process"
import http from "node:http"
import { KS_NAME } from "../guard/entries.ts"
import { defaultConfig } from "../shared/config.ts"
import { DelegateError } from "../shared/errors.ts"
import { silentLogger, type Logger } from "../shared/log.ts"
import { expectOk, type McpStatus, type OpencodeApi } from "../shared/opencode-api.ts"

export const LOGIN_PORT = 19876
export const CALLBACK_PATH = "/mcp/oauth/callback"
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** Entry names: the guard's KS_NAME (one rule for profile, runtime and sign-in; review A-20). */
const MAX_ENTRY_LENGTH = 67

export type LoginOptions = {
  /** Opens the authorization URL in the owner's browser. Default: rundll32 url.dll,FileProtocolHandler. */
  opener?: (url: string) => void
  /** Loopback port the box's redirect_uri points at. Default 19876. */
  port?: number
  timeoutMs?: number
  /** Instance directory for the box API calls. Default `/sessions`. */
  directory?: string
  /** The only origin whose authorization URL the bridge will open. Default: config.keystoneOrigin. */
  authOrigin?: string
  logger?: Logger
}

type Received = { code: string | undefined; reply(status: number, text: string): Promise<void> }

type Listener = { expect(state: string): void; received: Promise<Received>; close(): Promise<void> }

export function defaultOpener(url: string): void {
  const [file, args]: [string, string[]] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]]
  const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true })
  child.on("error", () => {})
  child.unref()
}

function page(res: http.ServerResponse, status: number, text: string): Promise<void> {
  return new Promise((resolve) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close", "cache-control": "no-store" })
    res.end(text, () => resolve())
  })
}

function handler(listener: { state?: string; handled: boolean; deliver(r: Received): void }, logger: Logger) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) return void page(res, 404, "Not found.")
    if (listener.handled) return void page(res, 409, "This sign-in was already handled. You can close this tab.")
    const state = url.searchParams.get("state")
    const code = url.searchParams.get("code") ?? undefined
    const denied = url.searchParams.has("error")
    if (!listener.state || state !== listener.state || (!code && !denied)) {
      logger.log("warn", "login", "callback refused: state mismatch or missing code")
      return void page(res, 400, "State mismatch or missing code. Nothing was sent.")
    }
    listener.handled = true
    listener.deliver({ code: denied ? undefined : code, reply: (status, text) => page(res, status, text) })
  }
}

async function openListener(port: number, logger: Logger): Promise<Listener> {
  let deliver: (r: Received) => void = () => {}
  const received = new Promise<Received>((resolve) => (deliver = resolve))
  const holder: { state?: string; handled: boolean; deliver(r: Received): void } = { handled: false, deliver: (r) => deliver(r) }
  const server = http.createServer(handler(holder, logger))
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE" && error.code !== "EACCES") return reject(error)
      reject(new DelegateError("port_busy", `The sign-in port 127.0.0.1:${port} is in use.`, "Finish or close the other sign-in (for example the OpenCode TUI), then retry oc_login."))
    })
    server.listen(port, "127.0.0.1", () => resolve())
  })
  // Always resolves (an already-closed server reports an error to the callback; that is fine).
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  return { expect: (state) => (holder.state = state), received, close }
}

function checkAuthUrl(raw: string, authOrigin: string): void {
  let origin: string
  try {
    origin = new URL(raw).origin
  } catch {
    origin = ""
  }
  if (origin !== authOrigin) throw new DelegateError("policy_violation", "The sign-in URL from the box is not a Keystone URL; it was not opened.", "Run oc_doctor.")
}

async function entryStatus(api: OpencodeApi, entry: string, directory: string): Promise<"connected" | "failed"> {
  const result = await api.call<Record<string, McpStatus>>({ path: "/mcp", directory })
  return result.status === 200 && result.data?.[entry]?.status === "connected" ? "connected" : "failed"
}

async function relay(api: OpencodeApi, entry: string, directory: string, got: Received, logger: Logger) {
  if (!got.code) {
    logger.log("warn", "login", "sign-in was declined or not completed", { entry })
    await got.reply(400, "Sign-in was not completed. Nothing was sent. You can close this tab.")
    return "failed" as const
  }
  let status: number
  try {
    status = (await api.call({ method: "POST", path: `/mcp/${entry}/auth/callback`, directory, body: { code: got.code } })).status
  } catch (error) {
    await got.reply(502, "The delegate box could not be reached. Nothing else was sent. You can close this tab.")
    throw error
  }
  const ok = status >= 200 && status < 300
  logger.log(ok ? "info" : "warn", "login", "callback relayed", { entry, status })
  await got.reply(ok ? 200 : 502, ok ? "Sign-in relayed to the delegate box. You can close this tab." : `The delegate box refused the sign-in (HTTP ${status}). You can close this tab.`)
  return entryStatus(api, entry, directory)
}

/**
 * Keystone sign-in for one ks-* entry. Box calls go through `api`, so they inherit its deadline
 * (DEFAULT_API_TIMEOUT_MS); the listener is closed on every path, including a throw.
 */
export async function login(api: OpencodeApi, entry: string, opts: LoginOptions = {}): Promise<"connected" | "failed"> {
  if (!KS_NAME.test(entry) || entry.length > MAX_ENTRY_LENGTH) {
    throw new DelegateError("invalid_input", "Only ks-* entries can be signed in.", "Pass a ks-* server name (lower-case, for example ks-delegate).")
  }
  const logger = opts.logger ?? silentLogger
  const directory = opts.directory ?? "/sessions"
  const listener = await openListener(opts.port ?? LOGIN_PORT, logger)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const started = expectOk(await api.call<{ authorizationUrl?: string; oauthState?: string }>({ method: "POST", path: `/mcp/${entry}/auth`, directory, body: {} }), "start the Keystone sign-in")
    if (!started.authorizationUrl) return await entryStatus(api, entry, directory) // already signed in
    if (!started.oauthState) throw new DelegateError("upstream_error", "The delegate box did not return a sign-in state.", "Retry oc_login.")
    checkAuthUrl(started.authorizationUrl, opts.authOrigin ?? defaultConfig().keystoneOrigin)
    listener.expect(started.oauthState)
    ;(opts.opener ?? defaultOpener)(started.authorizationUrl)
    logger.log("info", "login", "browser opened; waiting for the loopback redirect", { entry })
    const timeout = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), opts.timeoutMs ?? LOGIN_TIMEOUT_MS)))
    const got = await Promise.race([listener.received, timeout])
    if (!got) {
      logger.log("warn", "login", "sign-in timed out", { entry })
      return "failed"
    }
    return await relay(api, entry, directory, got, logger)
  } finally {
    if (timer) clearTimeout(timer)
    await listener.close()
  }
}
