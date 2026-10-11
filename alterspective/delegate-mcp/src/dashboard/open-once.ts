// iter-8 (#129 follow-on): open the dashboard in the owner's browser once per bridge home - the
// first time any bridge runs - and never again after that. The marker lives under the home like
// report-salt; the write is temp+rename so concurrent bridges land on one file (worst case two
// tabs, one marker - a local convenience, not worth a lock). Every path is swallowed and logged:
// a failed marker costs one extra tab next start, a throw would take down the bridge. The opener
// is injected (the bridge uses defaultOpener from supervisor/login.ts, which spawns detached).
import { mkdirSync } from "node:fs"
import path from "node:path"
import { renameWithRetry } from "../synapse/fs-retry.ts"
import type { Logger } from "../shared/log.ts"

export const DASHBOARD_OPENED_FILE = "dashboard-opened"

/** Whether the browser has already been opened for this bridge home (the marker file). */
export async function dashboardOpenedBefore(home: string): Promise<boolean> {
  const existing = await Bun.file(path.join(home, DASHBOARD_OPENED_FILE)).text().catch(() => "")
  return existing.trim().length > 0
}

export type OpenOnceDeps = {
  home: string
  /** A name to record in the marker (the bridge); never the token URL. */
  label: string
  url: string
  log: Logger
  open: (url: string) => void
  write?: (file: string, content: string) => Promise<void>
}

/** Opens the dashboard only while the marker is absent; returns whether the browser was opened. */
export async function ensureDashboardOpened(deps: OpenOnceDeps): Promise<boolean> {
  const marker = path.join(deps.home, DASHBOARD_OPENED_FILE)
  const existing = await Bun.file(marker).text().catch(() => "")
  if (existing.trim().length > 0) return false
  try {
    deps.open(deps.url)
  } catch (error) {
    deps.log.log("warn", "dashboard", "the browser could not be opened; oc_dashboard still returns the link", { error: String(error).slice(0, 200) })
    return false
  }
  // The marker is a flag only: the dashboard URL carries this bridge's secret path token, and a
  // durable file holding it outlives the process it belongs to. Timestamp + bridge name is enough.
  const write = deps.write ?? ((file: string, content: string) => Bun.write(file, content).then(() => undefined))
  try {
    mkdirSync(deps.home, { recursive: true })
    const tmp = `${marker}.${process.pid}.tmp`
    await write(tmp, `${new Date().toISOString()} ${deps.label}\n`)
    await renameWithRetry(tmp, marker)
  } catch (error) {
    deps.log.log("warn", "dashboard", "first-open marker not written; the dashboard may open again next start", { error: String(error).slice(0, 200) })
  }
  return true
}
