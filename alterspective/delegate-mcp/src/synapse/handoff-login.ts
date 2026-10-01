// WS2 (#48): the owner's Keystone sign-in for app `opencode`, caught on the HOST (never in the box).
// The bridge opens the owner's browser on Keystone's handoff login, listens on
// 127.0.0.1:1459/auth/callback (the callback registered on the production app), and accepts only a
// handoff JWT whose `nonce` is the one this attempt made (the plugin's state check). The handoff and
// the URL query are never logged.
import { randomBytes } from "node:crypto"
import http from "node:http"
import { DelegateError } from "../shared/errors.ts"
import { SYNAPSE_CALLBACK_PATH, SYNAPSE_LOGIN_PORT, handoffLoginUrl, jwtClaims, synapseRedirectUri } from "./keystone-token.ts"
import { JWT_RE } from "./auth-conf.ts"

export const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

export type HandoffOptions = { origin: string; opener: (url: string) => void; port?: number; timeoutMs?: number }

/** Open the browser, wait for the callback, return the handoff JWT. */
export async function catchHandoff(options: HandoffOptions): Promise<string> {
  const port = options.port ?? SYNAPSE_LOGIN_PORT
  const nonce = randomBytes(24).toString("base64url")
  const { server, handoff } = listen(port, nonce)
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "EADDRINUSE" ? new DelegateError("port_busy", `Port ${port} (the Synapse sign-in callback) is in use.`, "Finish or close the other sign-in (often an OpenCode Synapse sign-in), then retry.", `listen ${port}: EADDRINUSE`) : error),
    )
    server.listen(port, "127.0.0.1", () => resolve())
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DelegateError("needs_auth", "The Synapse sign-in did not finish in time.", "Run oc_login {server: \"synapse\"} again and finish the sign-in in the browser.")), options.timeoutMs ?? SIGN_IN_TIMEOUT_MS)
  })
  try {
    options.opener(handoffLoginUrl(options.origin, synapseRedirectUri(port), nonce))
    return await Promise.race([handoff, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    // Let the browser finish loading the reply page before the listener goes (plugin note).
    setTimeout(() => server.close(), 2_000).unref?.()
  }
}

function listen(port: number, nonce: string): { server: http.Server; handoff: Promise<string> } {
  let deliver: (value: string) => void = () => {}
  let fail: (error: Error) => void = () => {}
  const handoff = new Promise<string>((resolve, reject) => ((deliver = resolve), (fail = reject)))
  let done = false
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`)
    if (url.pathname !== SYNAPSE_CALLBACK_PATH || done) return reply(res, 404, "Not found.")
    const token = url.searchParams.get("handoff") ?? ""
    // Review L2: an error only ends THIS attempt when it carries this attempt's nonce (or state);
    // any page could otherwise cancel the owner's sign-in with a crafted link.
    const carried = url.searchParams.get("nonce") ?? url.searchParams.get("state")
    if (url.searchParams.get("error")) {
      if (carried !== nonce) return reply(res, 400, "This sign-in link does not match. Start the sign-in again.")
      done = true
      fail(new DelegateError("needs_auth", "Keystone ended the Synapse sign-in with an error.", "Run oc_login {server: \"synapse\"} again."))
      return reply(res, 200, "Sign-in failed. You can close this tab.")
    }
    // A different attempt's (or a forged) handoff is refused without ending this attempt.
    if (!JWT_RE.test(token) || jwtClaims(token)?.nonce !== nonce) return reply(res, 400, "This sign-in link does not match. Start the sign-in again.")
    done = true
    deliver(token)
    return reply(res, 200, "Signed in to Synapse for the OpenCode sandbox. You can close this tab.")
  })
  return { server, handoff }
}

function reply(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close", "cache-control": "no-store" })
  res.end(text)
}
