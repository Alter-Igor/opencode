// #129: the dashboard's HTTP server. Local only: it binds 127.0.0.1 on a random port, answers GET
// only, hides every route behind a random path token, and rejects any Host header other than
// 127.0.0.1:<port> (DNS rebinding). It serves the constant page/script/style, the fixed brand
// asset set (assets.ts - an exact-name registry, nothing else resolves), and one JSON document;
// no data is ever put into the HTML. It never keeps the process alive.
import { timingSafeEqual } from "node:crypto"
import path from "node:path"
import type { DashboardData } from "./data.ts"
import { DASHBOARD_HTML } from "./page.ts"
import { DASHBOARD_CSS } from "./style.ts"
import { DASHBOARD_APP_JS } from "./app.ts"
import { DASHBOARD_ASSETS } from "./assets.ts"

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export type Dashboard = { url: string; port: number; stop(): void }

export function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")
}

export function startDashboard(getData: () => Promise<DashboardData> | DashboardData): Dashboard {
  const token = newToken()
  const prefix = `/${token}/`
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const reply = (body: string | null, status: number, type?: string, extra?: Record<string, string>) =>
        new Response(body, {
          status,
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            ...(type ? { "content-type": type } : {}),
            ...extra,
          },
        })
      if (request.headers.get("host") !== `127.0.0.1:${server.port}`) return reply(null, 403)
      if (request.method !== "GET") return reply(null, 405, undefined, { allow: "GET" })
      const route = new URL(request.url).pathname
      if (!route.startsWith(prefix) || !sameToken(route.slice(1, prefix.length - 1), token)) return reply(null, 404)
      switch (route.slice(prefix.length)) {
        case "":
          return reply(DASHBOARD_HTML, 200, "text/html; charset=utf-8", { "content-security-policy": CSP })
        case "app.js":
          return reply(DASHBOARD_APP_JS, 200, "text/javascript; charset=utf-8")
        case "styles.css":
          return reply(DASHBOARD_CSS, 200, "text/css; charset=utf-8")
        case "data.json":
          return Promise.resolve(getData()).then(
            (data) => reply(JSON.stringify(data), 200, "application/json; charset=utf-8"),
            () => reply(null, 500),
          )
        default: {
          const asset = DASHBOARD_ASSETS[route.slice(prefix.length) as keyof typeof DASHBOARD_ASSETS]
          if (!asset) return reply(null, 404)
          return new Response(Bun.file(path.join(import.meta.dir, asset.file)), {
            status: 200,
            headers: {
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "referrer-policy": "no-referrer",
              "content-type": asset.type,
            },
          })
        }
      }
    },
  })
  // Never keep the bridge process alive for the sake of a browser tab.
  server.unref()
  return { url: `http://127.0.0.1:${server.port}${prefix}`, port: server.port ?? 0, stop: () => void server.stop(true) }
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}
