// iter-9 PR-2 evidence (UX-BRAND-07 / 07a, runbook AIRUN-025 steps 4/4a/4b): the dashboard's brand
// type is proved by the USED-FONT probe (CDP CSS.getPlatformFontsForNode), never getComputedStyle,
// plus the mandatory negative control that shows the probe actually discriminates. Requires a
// browser on 127.0.0.1:9333 with --remote-debugging-port. Prints PASS/FAIL per face per viewport.
import { startDashboard } from "../src/dashboard/server.ts"
import { dashboardData } from "../src/dashboard/data.ts"

const rec = (model: string, outcome: "completed" | "error" | "running") => ({
  v: 1 as const,
  sessionID: `ses_${model}`,
  key: `k-${model}`,
  bridge: "claude-main",
  repo: "proj-x",
  startedAt: new Date(Date.now() - 600_000).toISOString(),
  sendCount: 1,
  outcome,
  collected: false,
  disposition: "open" as const,
  ...(outcome === "error" ? { errorCode: "other" } : {}),
  requestedModel: `synapse/${model}`,
  servedModels: { [model]: 2 },
})
const records = [rec("openai/gpt-6-astra", "completed"), rec("qwen3.8-27b-dflash2", "error"), rec("moonshotai/kimi-k3", "running")]

const PORT = 9333
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function cdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true })
    ws.addEventListener("error", rej, { once: true })
  })
  let id = 0
  const waiting = new Map<number, (v: any) => void>()
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data))
    if (m.id !== undefined) {
      waiting.get(m.id)?.(m)
      waiting.delete(m.id)
    }
  })
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((res) => {
      const n = ++id
      waiting.set(n, res)
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  return { send, close: () => ws.close() }
}

const dashboard = startDashboard(() => dashboardData(records, Date.now(), { boxRunning: true, bridge: "claude-main" }))
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
const page = await cdp(version.webSocketDebuggerUrl)

const TARGETS = [
  { sel: "h1", expect: "Chronicle Display", why: "40px title (TYPO-001)" },
  { sel: "h2", expect: "Montserrat", why: "24px section heading" },
  { sel: "body", expect: "Montserrat", why: "UI text below 36px" },
  { sel: "td", expect: "Montserrat", why: "table body" },
]

async function probeFont(sessionId: string, selector: string): Promise<string[]> {
  const doc = await page.send("DOM.getDocument", { depth: 1 }, sessionId)
  const root = doc.result.root.nodeId
  const q = await page.send("DOM.querySelector", { nodeId: root, selector }, sessionId)
  const nodeId = q.result.nodeId
  if (!nodeId) return []
  const fonts = await page.send("CSS.getPlatformFontsForNode", { nodeId }, sessionId)
  return (fonts.result.fonts ?? []).map((f: { familyName: string; glyphCount: number }) => `${f.familyName}(${f.glyphCount})`)
}

for (const width of [1280, 380]) {
  const { targetId } = await (await page.send("Target.createTarget", { url: "about:blank" })).result
  const { sessionId } = await (await page.send("Target.attachToTarget", { targetId, flatten: true })).result
  await page.send("Page.enable", {}, sessionId)
  await page.send("DOM.enable", {}, sessionId)
  await page.send("CSS.enable", {}, sessionId)
  await page.send("Emulation.setDeviceMetricsOverride", { width, height: 940, deviceScaleFactor: 1, mobile: width < 500 }, sessionId)
  await page.send("Page.navigate", { url: dashboard.url }, sessionId)
  for (let i = 0; i < 60; i++) {
    const ready = await page.send("Runtime.evaluate", { expression: `!!document.querySelector("h2") && document.fonts.status === "loaded"`, returnByValue: true }, sessionId)
    if (ready.result?.result?.value === true) break
    await sleep(200)
  }
  const loaded = await page.send("Runtime.evaluate", { expression: `[...document.fonts].filter(f=>f.status==="loaded").map(f=>f.family+" "+f.weight)`, returnByValue: true }, sessionId)
  console.log(`\n### viewport ${width}px`)
  console.log("loaded faces:", JSON.stringify(loaded.result.value))
  for (const t of TARGETS) {
    const found = await probeFont(sessionId, t.sel)
    const hit = found.some((f) => f.startsWith(t.expect))
    console.log(`${hit ? "PASS" : "FAIL"} ${t.sel.padEnd(5)} want ${t.expect.padEnd(17)} used ${found.join(", ") || "(none)"}  [${t.why}]`)
  }
  // 4b: negative control - force the fallback on the h1 and the probe MUST change.
  const before = await probeFont(sessionId, "h1")
  await page.send("Runtime.evaluate", { expression: `document.querySelector("h1").style.fontFamily = "Georgia, serif"`, returnByValue: true }, sessionId)
  await sleep(200)
  const after = await probeFont(sessionId, "h1")
  const changed = JSON.stringify(before) !== JSON.stringify(after)
  console.log(`${changed ? "PASS" : "FAIL"} negative control: h1 ${before.join(",")} -> ${after.join(",")} (must change; if not, the probe is broken)`)
  await page.send("Target.closeTarget", { targetId })
}

dashboard.stop()
page.close()
process.exit(0)


