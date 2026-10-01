// FEAT-OCD-001 MOD-05: test helper that runs the inbox sidecar's two listeners (box and admin) on
// random 127.0.0.1 ports, each accepting only its own Host header, like main.ts does.
import { createHandlers, type Handlers, type LogLine } from "../inbox-sidecar/src/server.ts"
import { InboxStore, type StoreOptions } from "../inbox-sidecar/src/store.ts"

export type Sidecar = {
  boxUrl: string
  adminUrl: string
  store: InboxStore
  handlers: Handlers
  logs: LogLine[]
  stop: () => void
}

export type SidecarOptions = { dir: string; token: string; now?: () => number; store?: Omit<StoreOptions, "dir">; boxHandler?: (request: Request) => Promise<Response> }

export function startSidecar(options: SidecarOptions): Sidecar {
  const store = InboxStore.open({ dir: options.dir, ...options.store })
  const logs: LogLine[] = []
  let handlers: Handlers | undefined
  const box = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => (options.boxHandler ?? handlers!.box)(r) })
  const admin = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => handlers!.admin(r) })
  handlers = createHandlers({
    store, adminToken: options.token, now: options.now, log: (line) => void logs.push(line),
    boxHosts: [`127.0.0.1:${box.port}`], adminHosts: [`127.0.0.1:${admin.port}`],
  })
  const stop = () => {
    handlers!.stop()
    void box.stop(true)
    void admin.stop(true)
    store.close()
  }
  return { boxUrl: `http://127.0.0.1:${box.port}`, adminUrl: `http://127.0.0.1:${admin.port}`, store, handlers, logs, stop }
}
