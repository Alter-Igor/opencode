// #118: the supervisor's own check that the box cannot reach the cloud metadata endpoint, whoever
// was supposed to lock egress down. A TCP connect that succeeds means the box is not locked:
// refuse to start. Anything else (refused, unreachable, timeout) passes.
import net from "net"

export const METADATA = { host: "169.254.169.254", port: 80 }

export type GuardResult = { ok: true; detail: string } | { ok: false; detail: string }

export function checkUnreachable(target = METADATA, timeoutMs = 1500): Promise<GuardResult> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: target.host, port: target.port })
    const done = (result: GuardResult) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs, () => done({ ok: true, detail: "timed out" }))
    socket.once("connect", () => done({ ok: false, detail: `${target.host}:${target.port} accepted a connection` }))
    socket.once("error", (error: NodeJS.ErrnoException) => done({ ok: true, detail: error.code ?? "error" }))
  })
}
