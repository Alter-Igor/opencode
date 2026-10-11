// #129 dashboard: the pure data function, the local server, the constant page and oc_dashboard.
import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { dashboardData } from "../src/dashboard/data.ts"
import { DASHBOARD_HTML } from "../src/dashboard/page.ts"
import { DASHBOARD_APP_JS } from "../src/dashboard/app.ts"
import { DASHBOARD_CSS } from "../src/dashboard/style.ts"
import { dashboardOpenedBefore } from "../src/dashboard/open-once.ts"
import { CSP, startDashboard, type Dashboard } from "../src/dashboard/server.ts"
import { EXIT, parseCli, runDashboard } from "../src/cli.ts"
import type { Runtime } from "../src/runtime.ts"
import type { TaskRecord } from "../src/reporting/record.ts"
import { dashboardTool, openDashboardOnce, stopDashboard } from "../src/tools/dashboard.ts"
import { allTools, coreTools } from "../src/tools/index.ts"
import { data as dataOf, fakeContext, invoke } from "./tools-core-fixture.ts"

const NOW = Date.parse("2026-10-05T12:00:00.000Z")
const HOUR = 3_600_000
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const extras = { boxRunning: true, bridge: "me" }

let counter = 0
function rec(over: Partial<TaskRecord> = {}): TaskRecord {
  counter++
  return {
    v: 1,
    sessionID: `ses_${String(counter).padStart(18, "0")}`,
    key: `k${counter}`,
    bridge: "alpha",
    repo: "demo",
    startedAt: ago(HOUR),
    sendCount: 1,
    outcome: "completed",
    collected: false,
    disposition: "open",
    ...over,
  }
}

describe("dashboardData", () => {
  test("busy count, header fields and the running list (newest first)", () => {
    const d = dashboardData(
      [
        rec({ outcome: "running", startedAt: ago(3 * HOUR), requestedModel: "synapse/auto", sendCount: 2, lastSendAt: ago(HOUR) }),
        rec({ outcome: "running", startedAt: ago(HOUR), bridge: "beta", servedModels: { "m/x": 2 } }),
        rec({ outcome: "completed" }),
      ],
      NOW,
      { boxRunning: false, bridge: "me" },
    )
    expect(d.asOf).toBe(new Date(NOW).toISOString())
    expect(d.bridge).toBe("me")
    expect(d.boxRunning).toBe(false)
    expect(d.busy).toBe(2)
    expect(d.running.map((r) => r.bridge)).toEqual(["beta", "alpha"])
    expect(d.running[0]).toMatchObject({ elapsedMs: HOUR, servedModels: { "m/x": 2 }, sendCount: 1 })
    expect(d.running[1]).toMatchObject({ elapsedMs: 3 * HOUR, requestedModel: "synapse/auto", sendCount: 2, lastSendAt: ago(HOUR) })
  })

  test("per-caller counts (bridge when a record has no caller), 24 h and 7 day windows, sorted by running then name", () => {
    const d = dashboardData(
      [
        rec({ bridge: "zed", outcome: "running" }),
        rec({ bridge: "zed", startedAt: ago(2 * DAY) }),
        rec({ bridge: "alpha", startedAt: ago(2 * HOUR) }),
        rec({ bridge: "alpha", startedAt: ago(6 * DAY) }),
        rec({ bridge: "alpha", startedAt: ago(8 * DAY) }),
        rec({ bridge: "beta", startedAt: ago(HOUR) }),
      ],
      NOW,
      extras,
    )
    expect(d.callers).toEqual([
      { who: "zed", running: 1, last24h: 1, last7d: 2 },
      { who: "alpha", running: 0, last24h: 1, last7d: 2 },
      { who: "beta", running: 0, last24h: 1, last7d: 1 },
    ])
  })

  test("#132: groups by caller; several sessions on one bridge name are told apart, old records fall back to the bridge", () => {
    const d = dashboardData(
      [
        rec({ caller: "proj-a", outcome: "running", startedAt: ago(HOUR) }),
        rec({ caller: "proj-a", startedAt: ago(2 * HOUR) }),
        rec({ caller: "proj-b", startedAt: ago(3 * HOUR) }),
        rec({ startedAt: ago(4 * HOUR) }),
      ],
      NOW,
      extras,
    )
    expect(d.callers).toEqual([
      { who: "proj-a", running: 1, last24h: 2, last7d: 2 },
      { who: "alpha", running: 0, last24h: 1, last7d: 1 },
      { who: "proj-b", running: 0, last24h: 1, last7d: 1 },
    ])
    expect(d.running[0]).toMatchObject({ bridge: "alpha", caller: "proj-a" })
    expect(d.recent.map((r) => r.caller)).toEqual(["proj-a", "proj-a", "proj-b", undefined])
    expect(d.recent[3]).not.toHaveProperty("caller")
  })

  test("recent keeps the last 7 days only, newest first, at most 200", () => {
    const many = Array.from({ length: 250 }, (_, i) => rec({ startedAt: ago(1000 + i * 1000) }))
    const old = rec({ startedAt: ago(7 * DAY + 1000) })
    const d = dashboardData([old, ...many], NOW, extras)
    expect(d.recent).toHaveLength(200)
    expect(d.recent[0]?.startedAt).toBe(ago(1000))
    expect(d.recent[199]?.startedAt).toBe(ago(1000 + 199 * 1000))
    expect(d.recent.some((r) => r.startedAt === old.startedAt)).toBe(false)
    expect(d.callers[0]?.last7d).toBe(250)
  })

  test("recent rows: main served model with a tie goes to the first name; fields carried", () => {
    const d = dashboardData(
      [
        rec({ servedModels: { "b/model": 3, "a/model": 3, "c/model": 1 }, outcome: "error", errorCode: "boom", finishedAt: ago(HOUR / 2), durationMs: 1800_000, disposition: "collected", requestedModel: "synapse/auto", caller: "proj" }),
        rec({ servedModels: { "z/big": 9, "a/small": 1 }, startedAt: ago(2 * HOUR) }),
        rec({ startedAt: ago(3 * HOUR) }),
      ],
      NOW,
      extras,
    )
    expect(d.recent[0]).toEqual({ bridge: "alpha", caller: "proj", repo: "demo", requestedModel: "synapse/auto", servedModel: "a/model", outcome: "error", startedAt: ago(HOUR), finishedAt: ago(HOUR / 2), durationMs: 1800_000, errorCode: "boom", disposition: "collected" })
    expect(d.recent[1]?.servedModel).toBe("z/big")
    expect(d.recent[2]?.servedModel).toBeUndefined()
  })

  test("served totals sum calls over 7 days only, sorted desc", () => {
    const d = dashboardData(
      [rec({ servedModels: { "a/m": 2, "b/m": 5 } }), rec({ servedModels: { "a/m": 4 } }), rec({ startedAt: ago(9 * DAY), servedModels: { "a/m": 100 } })],
      NOW,
      extras,
    )
    expect(d.servedModels).toEqual([
      { model: "a/m", calls: 6 },
      { model: "b/m", calls: 5 },
    ])
  })

  test("repo, model and bridge strings are cut to 128 characters", () => {
    const long = "x".repeat(300)
    const d = dashboardData([rec({ repo: long, requestedModel: long, servedModels: { [long]: 1 }, outcome: "running" }), rec({ repo: long, requestedModel: long, bridge: long, caller: long })], NOW, { boxRunning: true, bridge: long })
    expect(d.bridge).toHaveLength(128)
    expect(d.running[0]?.repo).toHaveLength(128)
    expect(d.running[0]?.requestedModel).toHaveLength(128)
    expect(Object.keys(d.running[0]?.servedModels ?? {})[0]).toHaveLength(128)
    expect(d.recent.every((r) => r.repo.length === 128 && r.bridge.length <= 128 && (r.caller ?? "").length <= 128 && (r.servedModel ?? "").length <= 128)).toBe(true)
    expect(d.callers.every((c) => c.who.length <= 128)).toBe(true)
    expect(d.servedModels[0]?.model).toHaveLength(128)
  })

  test("no records: empty lists, nothing busy", () => {
    const d = dashboardData([], NOW, extras)
    expect(d).toMatchObject({ busy: 0, callers: [], running: [], recent: [], servedModels: [], scorecard: { models: [], tasks: 0 } })
  })

  test("scorecard: the 30-day per-model rollup from scorecard() with the right row shape", () => {
    const d = dashboardData(
      [
        rec({ servedModels: { "a/m": 3, "b/m": 1 }, outcome: "completed", durationMs: 120_000, tokens: { input: 9_500, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
        rec({ servedModels: { "b/m": 1 }, outcome: "error", errorCode: "rate_limited", durationMs: 180_000, tokens: { input: 500, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
        rec({ servedModels: { "b/m": 1 }, outcome: "running" }),
      ],
      NOW,
      extras,
    )
    expect(d.scorecard).toMatchObject({ days: 30, since: new Date(NOW - 30 * DAY).toISOString(), tasks: 3 })
    expect(d.scorecard.generatedAt).toBe(new Date(NOW).toISOString())
    expect(d.scorecard.models.map((m) => m.model)).toEqual(["b/m", "a/m"])
    expect(d.scorecard.models[0]).toEqual({
      model: "b/m",
      kind: "served",
      tasks: 2.25,
      completed: 0.25,
      error: 1,
      aborted: 0,
      unknown: 0,
      running: 1,
      successRate: 0.2,
      medianMs: 150_000,
      p90Ms: 180_000,
      tokensIn: 2_875,
      tokensOut: 75,
      repos: 1,
      errorKinds: { rate_limited: 1 },
    })
    expect(d.scorecard.models[1]).toMatchObject({ model: "a/m", kind: "served", tasks: 0.75, successRate: 1, tokensIn: 7_125, medianMs: 120_000 })
  })

  test("scorecard: a requested-but-unserved model is a distinct requested-only row", () => {
    const d = dashboardData(
      [
        rec({ requestedModel: "synapse/ghost", servedModels: { "a/m": 2 }, outcome: "error", errorCode: "other" }),
        rec({ startedAt: ago(31 * DAY), requestedModel: "synapse/ghost" }),
      ],
      NOW,
      extras,
    )
    expect(d.scorecard.models).toEqual([
      expect.objectContaining({ model: "a/m", kind: "served", tasks: 1 }),
      expect.objectContaining({ model: "ghost", kind: "requested-only", tasks: 1, error: 1 }),
    ])
    expect(d.scorecard.tasks).toBe(1)
  })
})

describe("dashboard server", () => {
  const payload = dashboardData([rec({ outcome: "running" })], NOW, extras)

  async function withServer(fn: (d: Dashboard, base: string, token: string) => Promise<void>) {
    const d = startDashboard(() => payload)
    try {
      const url = new URL(d.url)
      await fn(d, `${url.protocol}//${url.host}`, url.pathname.split("/")[1] ?? "")
    } finally {
      d.stop()
    }
  }

  test("url shape: 127.0.0.1, a random port and a 32 hex token", async () => {
    await withServer(async (d, base, token) => {
      expect(d.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/)
      expect(token).toHaveLength(32)
      expect(base).toBe(`http://127.0.0.1:${d.port}`)
    })
    const a = startDashboard(() => payload)
    const b = startDashboard(() => payload)
    try {
      expect(a.url).not.toBe(b.url)
      expect(a.port).not.toBe(b.port)
    } finally {
      a.stop()
      b.stop()
    }
  })

  test("token route serves the page with the CSP and the safety headers", async () => {
    await withServer(async (d) => {
      const res = await fetch(d.url)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/html")
      expect(res.headers.get("content-security-policy")).toBe(CSP)
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(res.headers.get("x-content-type-options")).toBe("nosniff")
      expect(res.headers.get("referrer-policy")).toBe("no-referrer")
      expect(await res.text()).toBe(DASHBOARD_HTML)
      const js = await fetch(`${d.url}app.js`)
      expect(js.status).toBe(200)
      expect(js.headers.get("content-type")).toContain("javascript")
      expect(js.headers.get("cache-control")).toBe("no-store")
      expect(await js.text()).toBe(DASHBOARD_APP_JS)
      const css = await fetch(`${d.url}styles.css`)
      expect(css.status).toBe(200)
      expect(css.headers.get("content-type")).toContain("text/css")
      expect(css.headers.get("cache-control")).toBe("no-store")
      expect(await css.text()).toBe(DASHBOARD_CSS)
    })
  })

  test("CSP is the exact policy asked for", () => {
    expect(CSP).toBe("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
  })

  test("the brand assets serve through the same token gate, and unknown names 404", async () => {
    await withServer(async (d, base) => {
      const logo = await fetch(`${d.url}logo.png`)
      expect(logo.status).toBe(200)
      expect(logo.headers.get("content-type")).toContain("image/png")
      expect(logo.headers.get("cache-control")).toBe("no-store")
      expect((await logo.arrayBuffer()).byteLength).toBeGreaterThan(1000)
      expect((await fetch(`${d.url}logo-reversed.png`)).status).toBe(200)
      for (const icon of ["icon_sustain", "icon_build", "icon_validate", "icon_discover"]) {
        const res = await fetch(`${d.url}${icon}.svg`)
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toContain("image/svg")
        const text = await res.text()
        // the shipped vectors: outlined, currentColor, and no colour literal of their own (ICON-001)
        expect(text).toContain('stroke="currentColor"')
        expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}/)
      }
      // brand fonts: first-party woff2 (UX-BRAND-07a) served on the same gated server
      for (const face of ["chronicle-display-roman", "chronicle-display-semibold", "montserrat-regular", "montserrat-medium", "montserrat-semibold", "montserrat-bold"]) {
        const res = await fetch(`${d.url}fonts/${face}.woff2`)
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toBe("font/woff2")
        const head = new Uint8Array((await res.arrayBuffer()).slice(0, 4))
        expect(String.fromCharCode(...head)).toBe("wOF2")
      }
      expect(DASHBOARD_CSS).toContain('@font-face')
      expect(DASHBOARD_CSS).toContain('url("fonts/chronicle-display-roman.woff2")')
      expect(CSP).toContain("font-src 'self'")
      // names outside the fixed registry never resolve, with or without the token
      expect((await fetch(`${d.url}../server.ts`)).status).toBe(404)
      expect((await fetch(`${d.url}fonts/../../server.ts`)).status).toBe(404)
      expect((await fetch(`${d.url}fonts/anything.woff2`)).status).toBe(404)
      expect((await fetch(`${d.url}secrets.png`)).status).toBe(404)
      expect((await fetch(`${base}/logo.png`)).status).toBe(404)
    })
  })

  test("wrong token and no token are 404 with an empty body", async () => {
    await withServer(async (d, base) => {
      for (const path of ["/" + "0".repeat(32) + "/", "/", "/app.js", "/data.json", "/" + "0".repeat(32) + "/data.json"]) {
        const res = await fetch(base + path)
        expect(res.status).toBe(404)
        expect(await res.text()).toBe("")
        expect(res.headers.get("cache-control")).toBe("no-store")
      }
      expect((await fetch(`${d.url}nope`)).status).toBe(404)
    })
  })

  test("only GET: POST, PUT and DELETE are 405", async () => {
    await withServer(async (d) => {
      for (const method of ["POST", "PUT", "DELETE"]) expect((await fetch(d.url, { method })).status).toBe(405)
      expect((await fetch(`${d.url}data.json`, { method: "POST", body: "{}" })).status).toBe(405)
    })
  })

  test("a Host header other than 127.0.0.1:<port> is 403", async () => {
    await withServer(async (d) => {
      for (const host of ["evil.example", `evil.example:${d.port}`, `localhost:${d.port}`, "127.0.0.1", `127.0.0.1:${d.port + 1}`]) {
        const res = await fetch(`${d.url}data.json`, { headers: { host } })
        expect(res.status).toBe(403)
        expect(await res.text()).toBe("")
      }
      expect((await fetch(`${d.url}data.json`)).status).toBe(200)
    })
  })

  test("data.json returns getData() as JSON", async () => {
    await withServer(async (d) => {
      const res = await fetch(`${d.url}data.json`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("application/json")
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(await res.json()).toEqual(JSON.parse(JSON.stringify(payload)))
    })
  })

  test("a failing getData is a 500 with no detail", async () => {
    const d = startDashboard(() => Promise.reject(new Error("secret detail")))
    try {
      const res = await fetch(`${d.url}data.json`)
      expect(res.status).toBe(500)
      expect(await res.text()).toBe("")
    } finally {
      d.stop()
    }
  })

  test("listens on 127.0.0.1 only", async () => {
    await withServer(async (d) => {
      const seen = await Bun.connect({ hostname: "127.0.0.1", port: d.port, socket: { data() {}, open(s) { s.end() } } })
      seen.end()
      const lan = Object.values(require("node:os").networkInterfaces() as Record<string, Array<{ address: string; family: string; internal: boolean }>>)
        .flat()
        .find((i) => i.family === "IPv4" && !i.internal)
      if (lan) {
        const reached = await fetch(`http://${lan.address}:${d.port}/`, { signal: AbortSignal.timeout(1500) }).then(
          () => true,
          () => false,
        )
        expect(reached).toBe(false)
      }
      const out = Bun.spawnSync(["sh", "-c", `(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep ':${d.port} ' || true`]).stdout.toString()
      if (out.trim()) expect(out).toContain(`127.0.0.1:${d.port}`)
    })
  })
})

describe("dashboard page", () => {
  const page = DASHBOARD_HTML
  const script = DASHBOARD_APP_JS

  test("the script never writes markup or evaluates text", () => {
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) expect(script).not.toContain(banned)
    expect(script).toContain("textContent")
    expect(script).toContain("createElement")
  })

  test("one timer only, no reload button in the static page, no inline script", () => {
    expect(script.match(/setInterval\(/g)).toHaveLength(1)
    expect(page.toLowerCase()).not.toContain("<button")
    expect(page.match(/<script/g)).toHaveLength(1)
    expect(page).toContain('<script src="app.js"></script>')
    expect(page).toContain("<title>Delegated work</title>")
    // iter-8: no new escape channel either - the static page carries no forms and no links.
    expect(page.toLowerCase()).not.toContain("<form")
    expect(page.toLowerCase()).not.toContain("<a ")
  })

  test("brand token discipline: hexes live only in the :root block, CSS is var()/color-mix() only", () => {
    const tokens = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf("<style>"), DASHBOARD_HTML.indexOf("</style>"))
    const hexes = (text: string) => [...text.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toUpperCase()).sort()
    const brand = ["#075156", "#2C8248", "#ABDD65", "#17232D", "#E5EEEF", "#FFFFFF", "#F59E0B", "#BA1A1A", "#6B7280", "#0F171D", "#1A2530", "#E5EEEF", "#D0D8DC"]
    // every hex in the :root is a brand or dark-mode token (WEBSTA-001-UX-QUALITY UX-BRAND-08a)
    for (const hex of hexes(tokens)) expect(brand).toContain(hex)
    // and nowhere else: outside the style block the page, the script and the stylesheet carry no colour literal
    const outside = DASHBOARD_HTML.slice(0, DASHBOARD_HTML.indexOf("<style>")) + DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf("</style>")) + script + DASHBOARD_CSS
    expect(outside).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(outside).not.toContain("rgb(")
    expect(outside).not.toContain("rgba(")
    expect(outside).not.toContain("hsl(")
    expect(DASHBOARD_CSS).toContain("color-mix(")
    // brand constants (the --as-*) are never redefined: each appears exactly once, in the token block
    for (const token of ["--as-marine", "--as-green", "--as-citrus", "--as-navy", "--as-pale-blue", "--as-white"]) {
      expect(tokens.match(new RegExp(`${token}:`, "g"))).toHaveLength(1)
    }
  })

  test("logo, tablist and four static views are in the page: a small app, not one long page", () => {
    // LOGO-004: a real img, at least 120px wide; LOGO-001: it is not centred (flex bar, first child).
    expect(page).toContain('<img class="logo"')
    expect(page).toContain('alt="Alterspective"')
    expect(Number(page.match(/width="(\d+)"/)?.[1])).toBeGreaterThanOrEqual(120)
    expect(page).toContain('role="tablist"')
    expect(page).toContain('data-role="tabs"')
    for (const view of ["overview", "tasks", "models", "about"]) expect(page).toContain(`data-view="${view}"`)
    expect((page.match(/role="tabpanel"/g))?.length).toBe(4)
    expect(page).toContain("hidden><div data-role=\"body-tasks\"")
  })

  test("the stylesheet themes both ways and names every state beyond colour", () => {
    // A11Y-002 / UX-BRAND-08: explicit colours under both themes, never inherited.
    expect(page).toContain('[data-theme="dark"]')
    expect(page).toContain("@media (prefers-color-scheme: dark)")
    expect(DASHBOARD_CSS).toContain("prefers-reduced-motion")
    // colour is never the only signal: states are underlined/weight-styled, the re-routed row is dashed
    expect(DASHBOARD_CSS).toContain("text-decoration: underline")
    expect(DASHBOARD_CSS).toContain("border-style: dashed")
    // citrus is never a text colour on dark: the token appears only in a warning-border use
    expect(DASHBOARD_CSS).not.toContain("var(--as-citrus)")
    expect(DASHBOARD_CSS).not.toMatch(/:\s*(red|green|blue|white|black|gray|orange|yellow)\b/i)
  })

  test("boot wires the tabs: click and arrows switch views, the theme cycle re-skins and swaps the logo", async () => {
    // A DOM double rich enough for boot() to run: the tabs node answers addEventListener (the guard),
    // fetch serves one data.json, setInterval is captured but never fired.
    class E {
      children: E[] = []
      textContent = ""
      className = ""
      id = ""
      hidden = false
      attrs: Record<string, string> = {}
      style: Record<string, unknown> = { setProperty: (k: string, v: string) => void ((this as { css?: Record<string, string> }).css = { ...(this as { css?: Record<string, string> }).css, [k]: v }) }
      listeners: Record<string, ((event?: { key?: string }) => void)[]> = {}
      setAttribute(k: string, v: string) {
        this.attrs[k] = v
      }
      getAttribute(k: string) {
        return this.attrs[k] ?? null
      }
      removeAttribute(k: string) {
        delete this.attrs[k]
      }
      addEventListener(type: string, fn: (event?: { key?: string }) => void) {
        ;(this.listeners[type] ??= []).push(fn)
      }
      focus() {}
      appendChild(n: E) {
        this.children.push(n)
        return n
      }
      replaceChildren(...n: E[]) {
        this.children = n
      }
      fire(type: string, event?: { key?: string }) {
        for (const fn of this.listeners[type] ?? []) fn(event)
      }
    }
    const bySelector = new Map<string, E>()
    const tabs = new E()
    bySelector.set("[data-role=tabs]", tabs)
    for (const v of ["overview", "tasks", "models", "about"]) {
      bySelector.set(`#view-${v}`, new E())
      bySelector.set(`[data-role=body-${v}]`, new E())
    }
    const asof = new E()
    const notice = new E()
    const logo = new E()
    bySelector.set("[data-role=asof]", asof)
    bySelector.set("[data-role=notice]", notice)
    bySelector.set("[data-role=logo]", logo)
    const documentElement = new E()
    const doc = {
      createElement: () => new E(),
      querySelector: (sel: string) => bySelector.get(sel) ?? null,
      documentElement,
    }
    const data = dashboardData([rec({ outcome: "running" })], NOW, extras)
    const fetchFake = async () => ({ ok: true, json: async () => data })
    let tick: (() => Promise<void>) | undefined
    const setIntervalFake = (fn: () => Promise<void>) => {
      tick = fn
      return 0 as unknown as ReturnType<typeof setInterval>
    }
    const localStorageFake = { store: new Map<string, string>(), getItem(k: string) { return this.store.get(k) ?? null }, setItem(k: string, v: string) { this.store.set(k, v) } }
    new Function("document", "fetch", "setInterval", "localStorage", "matchMedia", "AbortSignal", DASHBOARD_APP_JS)(doc, fetchFake, setIntervalFake, localStorageFake, () => ({ matches: false, addEventListener: () => {} }), AbortSignal)
    // the script's first tick() is already running; let it land, then drive one more
    await new Promise((r) => setTimeout(r, 20))
    await tick?.()
    // four brand-iconed tabs plus the theme control
    expect(tabs.children.map((b) => b.attrs.role)).toEqual(["tab", "tab", "tab", "tab", undefined])
    const flat = (n: E): string => [n.textContent, ...n.children.flatMap(flat)].filter(Boolean).join("")
    expect(tabs.children.slice(0, 4).map(flat)).toEqual(["Overview", "Tasks", "Models", "About"])
    for (const b of tabs.children.slice(0, 4)) expect(((b.children[0] as E) as unknown as { css: Record<string, string> }).css["--icon"]).toContain(".svg")
    expect(logo.getAttribute("src")).toBe("logo.png")
    // click Models: only the models panel stays visible, the body carries the scorecard
    tabs.children[2]!.fire("click")
    expect(bySelector.get("#view-models")!.hidden).toBe(false)
    expect(bySelector.get("#view-overview")!.hidden).toBe(true)
    expect((bySelector.get("[data-role=body-models]") as E).children[0]!.children.length).toBeGreaterThan(0)
    // arrow from the active tab wraps to the next
    tabs.children[2]!.fire("keydown", { key: "ArrowRight" })
    expect(bySelector.get("#view-about")!.hidden).toBe(false)
    expect(bySelector.get("#view-models")!.hidden).toBe(true)
    // theme cycle: system -> light -> dark, with the reversed logo and localStorage keeping the choice
    tabs.children[4]!.fire("click")
    expect(documentElement.getAttribute("data-theme")).toBe("light")
    expect(logo.getAttribute("src")).toBe("logo.png")
    tabs.children[4]!.fire("click")
    expect(documentElement.getAttribute("data-theme")).toBe("dark")
    expect(logo.getAttribute("src")).toBe("logo-reversed.png")
    expect(localStorageFake.getItem("oc-dash-theme")).toBe("dark")
    // a notice path: a failing fetch says so without touching the views
    notice.hidden = true
    await new Function("document", "fetch", "setInterval", "localStorage", "matchMedia", "AbortSignal", DASHBOARD_APP_JS)(doc, async () => { throw new Error("down") }, setIntervalFake, localStorageFake, () => ({ matches: false, addEventListener: () => {} }), AbortSignal)
    await tick?.()
    expect(notice.hidden).toBe(false)
    expect(notice.textContent).toContain("bridge may have stopped")
  })

  test("the script's render builds the four views from data without a browser", () => {
    // A tiny DOM double: enough to run render() as a pure function of (data, now). render() returns a
    // root div holding the four view panels in order (overview, tasks, models, about).
    class Node {
      children: Node[] = []
      textContent = ""
      className = ""
      hidden = false
      style: Record<string, unknown> = { setProperty: () => {} }
      setAttribute() {}
      appendChild(n: Node) {
        this.children.push(n)
        return n
      }
      replaceChildren(...n: Node[]) {
        this.children = n
      }
    }
    const texts = (n: Node): string[] => [n.textContent, ...n.children.flatMap(texts)].filter(Boolean)
    const made = new Function(
      "document",
      "fetch",
      "setInterval",
      `${DASHBOARD_APP_JS.replace('"use strict";', "")}\nreturn { render, renderView, formatDuration, VIEWS };`,
    )({ createElement: () => new Node(), querySelector: () => new Node() }, async () => ({ ok: false }), () => 0) as { render(d: unknown, now: number): Node; renderView(v: string, d: unknown, now: number): Node; formatDuration(ms: number): string; VIEWS: Array<{ id: string; label: string }> }
    const empty = texts(made.render(dashboardData([], NOW, { boxRunning: false, bridge: "me" }), NOW)).join("|")
    for (const words of ["Box stopped", "0 tasks running", "Who is delegating", "Running now", "Nothing running.", "Recent tasks", "Models served (7 days)", "Model scorecard (30 days)", "About this page"]) expect(empty).toContain(words)
    expect(made.VIEWS.map((v) => v.id)).toEqual(["overview", "tasks", "models", "about"])
    const rendered = made.render(dashboardData([rec({ outcome: "running", repo: "<b>x</b>", caller: "proj-<i>", servedModels: { "m/a": 2 } })], NOW, extras), NOW)
    const full = texts(rendered).join("|")
    expect(full).toContain("<b>x</b>")
    expect(full).toContain("proj-<i>")
    expect(full).toContain("Session (project folder)")
    expect(full).toContain("Session|Bridge")
    expect(texts(made.render(dashboardData([rec({ outcome: "running" })], NOW, extras), NOW)).join("|")).toContain("n/a")
    expect(full).toContain("Running")
    expect(full).toContain("m/a (2 calls)")
    expect(made.formatDuration(3_725_000)).toBe("1 h 2 min")

    // #136 kept: the Session cell in the running and recent tables, reached by structure not flat text.
    const tasksView = rendered.children[1]
    const runningTable = tasksView?.children[0]?.children[1]?.children[0]
    expect(runningTable?.children[1]?.children[0]?.children[0]?.textContent).toBe("proj-<i>")
    const recentTable = tasksView?.children[1]?.children[1]?.children[0]
    expect(recentTable?.children[1]?.children[0]?.children[1]?.textContent).toBe("proj-<i>")
  })

  test("the scorecard renders a successRate:null row as 'no data yet' without crashing", () => {
    class Node {
      children: Node[] = []
      textContent = ""
      className = ""
      hidden = false
      style: Record<string, unknown> = { setProperty: () => {} }
      setAttribute() {}
      appendChild(n: Node) {
        this.children.push(n)
        return n
      }
      replaceChildren(...n: Node[]) {
        this.children = n
      }
    }
    const texts = (n: Node): string[] => [n.textContent, ...n.children.flatMap(texts)].filter(Boolean)
    const made = new Function(
      "document",
      "fetch",
      "setInterval",
      `${DASHBOARD_APP_JS.replace('"use strict";', "")}\nreturn { render };`,
    )({ createElement: () => new Node(), querySelector: () => new Node() }, async () => ({ ok: false }), () => 0) as { render(d: unknown, now: number): Node }
    const d = dashboardData([rec({ servedModels: { "b/m": 1 }, outcome: "running" })], NOW, extras)
    const full = texts(made.render(d, NOW)).join("|")
    expect(full).toContain("Model scorecard (30 days)")
    expect(full).toContain("the owner's on-prem tuning signal")
    expect(full).toContain("b/m")
    expect(full).toContain("no data yet")
  })

  test("a scorecard model name that is markup is only ever text", () => {
    class Node {
      children: Node[] = []
      textContent = ""
      className = ""
      hidden = false
      style: Record<string, unknown> = { setProperty: () => {} }
      setAttribute() {}
      appendChild(n: Node) {
        this.children.push(n)
        return n
      }
      replaceChildren(...n: Node[]) {
        this.children = n
      }
    }
    const texts = (n: Node): string[] => [n.textContent, ...n.children.flatMap(texts)].filter(Boolean)
    const made = new Function(
      "document",
      "fetch",
      "setInterval",
      `${DASHBOARD_APP_JS.replace('"use strict";', "")}\nreturn { render };`,
    )({ createElement: () => new Node(), querySelector: () => new Node() }, async () => ({ ok: false }), () => 0) as { render(d: unknown, now: number): Node }
    const d = dashboardData([rec({ servedModels: { "b/m": 1 }, outcome: "running" })], NOW, extras)
    d.scorecard.models.push({
      model: "<img src=x onerror=alert(1)>",
      kind: "requested-only",
      tasks: 1,
      completed: 0,
      error: 1,
      aborted: 0,
      unknown: 0,
      running: 0,
      successRate: null,
      medianMs: null,
      p90Ms: null,
      tokensIn: 0,
      tokensOut: 0,
      repos: 1,
      errorKinds: { other: 1 },
    })
    const full = texts(made.render(d, NOW)).join("|")
    // The markup survives only as text (a cell's textContent), never as a parsed element: no new node
    // is ever created for the attribute or the tag, so nothing renders as an <img> or a handler.
    expect(full).toContain("<img src=x onerror=alert(1)>")
    expect(full).toContain("re-routed")
    expect(full).toContain("no data yet")
  })
})

describe("oc_dashboard", () => {
  test("is registered right after oc_report with the read-only annotations and no input", () => {
    const names = coreTools.map((t) => t.name)
    expect(names.indexOf("oc_dashboard")).toBe(names.indexOf("oc_report") + 1)
    expect(allTools().filter((t) => t.name === "oc_dashboard")).toHaveLength(1)
    expect(dashboardTool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    expect(Object.keys(dashboardTool.input)).toEqual([])
  })

  test("a second call returns the same URL, and the page serves this bridge's data without starting the box", async () => {
    const f = fakeContext({ boxHeld: false })
    try {
      const first = await invoke(dashboardTool, {}, f.ctx)
      const second = await invoke(dashboardTool, {}, f.ctx)
      expect(first.isError).toBeUndefined()
      const url = String(dataOf(first).url)
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/)
      expect(dataOf(second).url).toBe(url)
      expect(String(dataOf(first).note)).toContain("only works on this machine")
      expect(String(dataOf(first).note)).toContain("stops when the bridge stops")
      const body = (await (await fetch(`${url}data.json`)).json()) as { bridge: string; boxRunning: boolean; busy: number }
      expect(body.bridge).toBe("test-bridge")
      expect(body.boxRunning).toBe(false)
      expect(typeof body.busy).toBe("number")
      expect(f.started.count).toBe(0)
      expect(f.hostCmds).toEqual([])
      expect(f.boxCmds).toEqual([])
    } finally {
      stopDashboard(f.ctx)
    }
  })

  test("openDashboardOnce: first call opens and marks, a second never opens again, and oc_dashboard still works", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.config.home = await mkdtemp(path.join(os.tmpdir(), "ocd-first-"))
    const opened: string[] = []
    try {
      expect(await openDashboardOnce(f.ctx, (url) => opened.push(url))).toBe(true)
      expect(opened).toHaveLength(1)
      expect(await dashboardOpenedBefore(f.ctx.config.home)).toBe(true)
      const before = opened.length
      expect(await openDashboardOnce(f.ctx, (url) => opened.push(url))).toBe(false)
      expect(opened).toHaveLength(before)
      // the page from the first call still answers
      const res = await fetch(`${opened[0]}data.json`)
      expect(res.status).toBe(200)
    } finally {
      stopDashboard(f.ctx)
    }
  })

  test("openDashboardOnce does not start the dashboard when the home was already opened", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.config.home = await mkdtemp(path.join(os.tmpdir(), "ocd-already-"))
    await writeFile(path.join(f.ctx.config.home, "dashboard-opened"), "2026-10-11T00:00:00.000Z earlier\n")
    const opened: string[] = []
    expect(await openDashboardOnce(f.ctx, (url) => opened.push(url))).toBe(false)
    expect(opened).toEqual([])
    expect(f.started.count).toBe(0)
  })
})

describe("cli dashboard", () => {
  test("parse: default opens the browser, --no-open turns it off, bad flags refused", () => {
    expect(parseCli(["dashboard"])).toEqual({ kind: "dashboard", open: true })
    expect(parseCli(["dashboard", "--no-open"])).toEqual({ kind: "dashboard", open: false })
    expect(parseCli(["dashboard", "--bogus"]).kind).toBe("error")
  })

  test("runDashboard prints the local link, serves data, stops with Ctrl-C, and never starts the box", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.config.home = await mkdtemp(path.join(os.tmpdir(), "ocd-clidash-"))
    const lines: string[] = []
    const errs: string[] = []
    let released = false
    const make = async () => ({ ctx: f.ctx, versionInfo: { version: "v", package: "0", sha: "x", dirty: false, built: null }, name: "cli-test", shutdown: async () => { released = true } }) as unknown as Runtime
    try {
      const code = await runDashboard({ out: (t) => lines.push(t), err: (t) => errs.push(t) }, false, make, () => Promise.resolve())
      expect(code).toBe(EXIT.ok)
      expect(lines[0]).toMatch(/^Dashboard: http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/)
      expect(lines.join("\n")).toContain("never starts the sandbox")
      expect(errs.join("")).toContain("--no-open")
      // --no-open: the marker was not written and the box was never touched
      expect(await dashboardOpenedBefore(f.ctx.config.home)).toBe(false)
      expect(released).toBe(true)
      expect(f.started.count).toBe(0)
      expect(f.boxCmds).toEqual([])
    } finally {
      stopDashboard(f.ctx)
    }
  })
})

