// #129 oc_dashboard: a local, read-only web page that shows delegated work across every bridge
// sharing this bridge home: how busy the box is, who delegated, which repos, which model was sent,
// which Synapse served, and each task's state and duration. The server (src/dashboard) binds
// 127.0.0.1 only, starts once per bridge process and stops with it. The page reads the same host-side
// task records as oc_report; it never starts the box and never calls Docker.
import { dashboardData } from "../dashboard/data.ts"
import { startDashboard, type Dashboard } from "../dashboard/server.ts"
import { flushReports, reportsFor } from "../reporting/hooks.ts"
import type { ToolContext } from "./context.ts"
import { defineTool } from "./define.ts"
import { ok } from "./shape.ts"

/** One dashboard per bridge (a bridge process has one context). Keyed by context so a test context never shares one. */
const running = new WeakMap<ToolContext, Dashboard>()

export const NOTE = "This link only works on this machine and stops when the bridge stops. It is read-only and refreshes itself every 5 seconds."

export const dashboardTool = defineTool({
  name: "oc_dashboard",
  title: "Delegation dashboard",
  description:
    "Returns a link to a local, read-only web page for the owner: how busy the box is, which bridges delegated, which repos, the model sent and the model Synapse served, and each task's state and duration, across all bridges sharing this bridge home. " +
    "Open it in a browser on this machine. The link works only on this machine and stops when the bridge stops. A second call returns the same link. It never starts the box.",
  input: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(_args, ctx) {
    const dashboard = running.get(ctx) ?? start(ctx)
    return ok(`Dashboard: ${dashboard.url}`, { url: dashboard.url, note: NOTE })
  },
})

function start(ctx: ToolContext): Dashboard {
  const bridge = ctx.supervisor.replace(/^supervisor:/, "")
  const dashboard = startDashboard(async () => {
    // This process's own queued updates first, so the page includes its latest work. No prune here:
    // the page polls every few seconds and stays read-only; oc_report and the bridge do retention.
    await flushReports()
    return dashboardData(reportsFor(ctx).list(), Date.now(), { boxRunning: ctx.peekBox() !== undefined, bridge })
  })
  running.set(ctx, dashboard)
  return dashboard
}

/** Stops this bridge's dashboard (tests; the process normally just exits). */
export function stopDashboard(ctx: ToolContext): void {
  running.get(ctx)?.stop()
  running.delete(ctx)
}
