// The dashboard's "Model scorecard" section: how the app script renders scorecard() rows - the rate
// bar width/colour thresholds, the "no data yet" state, re-routed badges, and the number formats.
// Runs the real DASHBOARD_APP_JS render() against a tiny DOM double, like test/dashboard.test.ts.
import { describe, expect, test } from "bun:test"
import { dashboardData } from "../src/dashboard/data.ts"
import { DASHBOARD_APP_JS } from "../src/dashboard/app.ts"
import type { TaskRecord } from "../src/reporting/record.ts"

const NOW = Date.parse("2026-10-05T12:00:00.000Z")
const HOUR = 3_600_000
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

const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)]

function makeRender() {
  return new Function(
    "document",
    "fetch",
    "setInterval",
    `${DASHBOARD_APP_JS.replace('"use strict";', "")}\nreturn { render };`,
  )({ createElement: () => new Node(), querySelector: () => new Node() }, async () => ({ ok: false }), () => 0) as { render(d: unknown, now: number): Node }
}

/** The Models view panel (render()'s third child): served table then the scorecard section. */
const scorecardSection = (root: Node): Node => root.children[2]?.children[1] ?? new Node()

const served = (model: string, outcome: TaskRecord["outcome"]) => rec({ servedModels: { [model]: 1 }, outcome, ...(outcome === "error" ? { errorCode: "other" } : {}) })
const repeat = (n: number, make: () => TaskRecord) => Array.from({ length: n }, make)

describe("dashboard scorecard section", () => {
  test("the rate bar's width and colour follow the successRate thresholds", () => {
    // good/m 17 done + 1 err = 18, 17/18 = 94% (>=85); bad/m 5/10 = 50% (<60); mid/m 6/9 = 67% (60-85).
    const d = dashboardData(
      [
        ...repeat(17, () => served("good/m", "completed")),
        served("good/m", "error"),
        ...repeat(5, () => served("bad/m", "completed")),
        ...repeat(5, () => served("bad/m", "error")),
        ...repeat(6, () => served("mid/m", "completed")),
        ...repeat(3, () => served("mid/m", "error")),
      ],
      NOW,
      extras,
    )
    const section = scorecardSection(makeRender().render(d, NOW))
    // Each Rate column <td> holds a <span.track> as its first child, then a <span.muted> sibling.
    const tracks = all(section).filter((n) => n.className === "track")
    expect(tracks.map((n) => n.children[0]?.className)).toEqual(["fill fill-good", "fill fill-bad", "fill fill-mid"])
    expect(tracks.map((n) => n.children[0]?.style.width)).toEqual(["94%", "50%", "67%"])
    // Find the <td> (parent) of each track and read its second child's text.
    const tds = all(section).filter((n) => n.children.some((c) => c.className === "track"))
    const rateTexts = tds.map((td) => {
      const i = td.children.findIndex((c) => c.className === "track")
      return td.children[i + 1]?.textContent ?? ""
    })
    expect(rateTexts).toEqual([" 94%", " 50%", " 67%"])
  })

  test("a successRate:null row shows the empty track and 'no data yet', without a fill", () => {
    const d = dashboardData([rec({ servedModels: { "b/m": 1 }, outcome: "running" })], NOW, extras)
    const nodes = all(scorecardSection(makeRender().render(d, NOW)))
    expect(nodes.some((n) => n.className === "track")).toBe(false)
    expect(nodes.some((n) => n.className === "fill")).toBe(false)
    expect(nodes.some((n) => n.className === "bar-none")).toBe(true)
    expect(nodes.some((n) => n.textContent === " no data yet")).toBe(true)
  })

  test("rows carry one-decimal tasks, err%, minutes and k tokens; requested-only rows get the re-routed badge", () => {
    const d = dashboardData(
      [
        rec({ servedModels: { "a/m": 3, "b/m": 1 }, outcome: "completed", durationMs: 150_000, tokens: { input: 12_400, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
        rec({ servedModels: { "b/m": 1 }, outcome: "error", errorCode: "other", durationMs: 30_000, tokens: { input: 400, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
        rec({ requestedModel: "synapse/ghost", servedModels: { "a/m": 2 }, outcome: "error", errorCode: "other" }),
      ],
      NOW,
      extras,
    )
    const section = scorecardSection(makeRender().render(d, NOW))
    // A body row is an <tr> of 8 cells (the header row is 8 <th>, each with a single text child).
    const rows = all(section).filter((n) => n.children.length === 8 && n.children.every((c) => c.children.length <= 3))
    const cellTexts = (row: Node) => row.children.map((c) => all(c).map((x) => x.textContent).join(""))
    // a/m: 1.75 tasks; err 1/1.75 = 57%; durations [150000] -> 2.5 min; in 9300 = 9.3k
    const aRow = rows.find((r) => cellTexts(r)[0]?.includes("a/m"))
    expect(cellTexts(aRow ?? new Node()).slice(1)).toEqual([" 43%", "1.8", "57%", "2.5 min", "2.5 min", "9.3k", "1"])
    // b/m: 1.25 tasks; err 1/1.25 = 80%; durations [150000, 30000] -> median 90000 = 1.5 min, p90 150000 = 2.5 min; in 3500 = 3.5k
    const bRow = rows.find((r) => cellTexts(r)[0]?.includes("b/m"))
    expect(cellTexts(bRow ?? new Node()).slice(1)).toEqual([" 20%", "1.3", "80%", "1.5 min", "2.5 min", "3.5k", "1"])
    // ghost: requested but never served -> its own row with the distinct re-routed badge
    const gRow = rows.find((r) => cellTexts(r)[0]?.includes("ghost"))
    expect(gRow).toBeDefined()
    expect(all(gRow ?? new Node()).some((c) => c.className === "badge badge-rerouted" && c.textContent === "re-routed")).toBe(true)
  })
})
