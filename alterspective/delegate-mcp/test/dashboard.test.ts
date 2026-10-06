// #129 dashboard: the pure data function, the local server, the constant page and oc_dashboard.
import { describe, expect, test } from "bun:test"
import { dashboardData } from "../src/dashboard/data.ts"
import { DASHBOARD_HTML, DASHBOARD_JS } from "../src/dashboard/page.ts"
import { CSP, startDashboard, type Dashboard } from "../src/dashboard/server.ts"
import type { TaskRecord } from "../src/reporting/record.ts"
import { dashboardTool, stopDashboard } from "../src/tools/dashboard.ts"
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
    expect(d).toMatchObject({ busy: 0, callers: [], running: [], recent: [], servedModels: [] })
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
      expect(await js.text()).toBe(DASHBOARD_JS)
    })
  })

  test("CSP is the exact policy asked for", () => {
    expect(CSP).toBe("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
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
  const both = DASHBOARD_HTML + "\n" + DASHBOARD_JS

  test("the script never writes markup or evaluates text", () => {
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) expect(DASHBOARD_JS).not.toContain(banned)
    expect(DASHBOARD_JS).toContain("textContent")
    expect(DASHBOARD_JS).toContain("createElement")
  })

  test("one timer only, no reload button, no inline script", () => {
    expect(DASHBOARD_JS.match(/setInterval\(/g)).toHaveLength(1)
    expect(DASHBOARD_JS).not.toContain("setTimeout(")
    expect(DASHBOARD_HTML.toLowerCase()).not.toContain("<button")
    expect(DASHBOARD_HTML.match(/<script/g)).toHaveLength(1)
    expect(DASHBOARD_HTML).toContain('<script src="app.js"></script>')
    expect(DASHBOARD_HTML).toContain("<title>Delegated work</title>")
  })

  test("only system colours: no hex, rgb(), hsl() or named colours", () => {
    expect(both).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(both).not.toContain("rgb(")
    expect(both).not.toContain("rgba(")
    expect(both).not.toContain("hsl(")
    expect(DASHBOARD_HTML).toContain("color-scheme: light dark")
    expect(DASHBOARD_HTML).toContain("color-mix(")
    const css = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf("<style>"), DASHBOARD_HTML.indexOf("</style>"))
    for (const named of ["red", "green", "blue", "white", "black", "gray", "orange", "yellow"]) expect(css).not.toMatch(new RegExp(`:\\s*${named}\\b`, "i"))
  })

  test("the script's render builds the sections from data without a browser", () => {
    // A tiny DOM double: enough to run render() as a pure function of (data, now).
    class Node {
      children: Node[] = []
      textContent = ""
      className = ""
      hidden = false
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
      `${DASHBOARD_JS.replace('"use strict";', "")}\nreturn { render, formatDuration };`,
    )({ createElement: () => new Node(), querySelector: () => new Node() }, async () => ({ ok: false }), () => 0) as { render(d: unknown, now: number): Node; formatDuration(ms: number): string }
    const empty = texts(made.render(dashboardData([], NOW, { boxRunning: false, bridge: "me" }), NOW)).join("|")
    for (const words of ["Box stopped", "0 tasks running", "Who is delegating", "Running now", "Nothing running.", "Recent tasks", "Models served (7 days)"]) expect(empty).toContain(words)
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

    // #136: assert the Session cell in "Running now" and "Recent tasks" separately (not only in flattened page text)
    const runningTable = rendered.children[2]?.children[1]?.children[0]
    expect(runningTable?.children[1]?.children[0]?.children[0]?.textContent).toBe("proj-<i>")
    const recentTable = rendered.children[3]?.children[1]?.children[0]
    expect(recentTable?.children[1]?.children[0]?.children[1]?.textContent).toBe("proj-<i>")
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
})
