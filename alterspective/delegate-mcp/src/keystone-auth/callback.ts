// #67 step 1: the host's loopback listener for a Keystone sign-in (like the step 0 spike). It catches
// Keystone's redirect to http://127.0.0.1:<port>/mcp/oauth/callback, checks `state`, and hands the
// code to the caller only. The code and the query string are never logged or echoed in the page.
// A request with the wrong state is answered 400 and IGNORED (the wait goes on), so another local
// process cannot cancel the owner's sign-in by guessing the port.
import http from "node:http"
import { DelegateError } from "../shared/errors.ts"
import { CALLBACK_PATH } from "../supervisor/login.ts"

export type CallbackListener = {
  /** The port actually bound (differs from the requested one only when 0 was asked for). */
  port: number
  /** Resolves with the authorization code for `state`; rejects on a refusal or the timeout. */
  wait(state: string, timeoutMs: number): Promise<string>
  close(): Promise<void>
}

/** Starts the listener. Injectable for tests via KeystoneAuthDeps.listen. */
export type Listen = (port: number) => Promise<CallbackListener>

/** An OAuth error code: short and plain, so it is safe to put in a message. */
const OAUTH_CODE = /^[a-z_]{1,64}$/

function page(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", connection: "close" })
  res.end(text)
}

/** Exactly one value for `key` (a repeated parameter could be read two ways). */
function single(q: URLSearchParams, key: string): string | undefined {
  const values = q.getAll(key)
  return values.length === 1 ? values[0] : undefined
}

/**
 * Listen on 127.0.0.1:`port` for the sign-in callback.
 *
 * @param port loopback port (LOGIN_PORT in production, 0 in tests)
 * @returns the listener
 * @throws DelegateError port_busy when the port is taken (another sign-in is running)
 * @example const listener = await loopbackListener(LOGIN_PORT)
 */
export const loopbackListener: Listen = (port) =>
  new Promise((resolveListen, rejectListen) => {
    let expected: string | undefined
    let settle: { resolve(code: string): void; reject(error: Error): void } | undefined
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      if (req.method !== "GET" || url.pathname !== CALLBACK_PATH || expected === undefined || settle === undefined) return page(res, 404, "Not found.")
      if (single(url.searchParams, "state") !== expected) return page(res, 400, "This sign-in link does not match the one in progress.")
      const error = single(url.searchParams, "error")
      const code = single(url.searchParams, "code")
      const done = settle
      settle = undefined
      if (error !== undefined || !code) {
        page(res, 400, "Sign-in was not completed. You can close this tab.")
        const named = error !== undefined && OAUTH_CODE.test(error) ? error : "no code"
        return done.reject(new DelegateError("needs_auth", `Keystone sign-in was not completed (${named}).`, "Sign in again and approve the connection.", `callback: ${named}`))
      }
      page(res, 200, "Signed in. You can close this tab.")
      done.resolve(code)
    })
    server.on("error", (error: NodeJS.ErrnoException) => {
      const busy = error.code === "EADDRINUSE"
      rejectListen(new DelegateError(busy ? "port_busy" : "upstream_error", busy ? `Port ${port} is in use; another sign-in may be running.` : "The sign-in listener could not start.", busy ? "Finish or cancel the other sign-in, then try again." : "Try again.", `listen: ${error.code ?? "error"}`))
    })
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()
      const bound = typeof address === "object" && address ? address.port : port
      resolveListen({
        port: bound,
        wait: (state, timeoutMs) =>
          new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
              settle = undefined
              reject(new DelegateError("needs_auth", "No Keystone sign-in arrived in time.", "Sign in again and approve within the time limit.", "callback: timeout"))
            }, timeoutMs)
            expected = state
            settle = {
              resolve: (code) => (clearTimeout(timer), resolve(code)),
              reject: (error) => (clearTimeout(timer), reject(error)),
            }
          }),
        close: () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
            server.closeAllConnections?.()
          }),
      })
    })
  })
