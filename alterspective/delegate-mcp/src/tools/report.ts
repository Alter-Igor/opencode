// #73 oc_report: what delegation delivered. Reads the host-side task records (src/reporting) of
// every bridge sharing this bridge home and summarises them: tasks, outcomes, success rate,
// median/p90 duration, and how much work was collected versus discarded, overall and per model,
// agent or repo. Read-only apart from retention. Records hold metadata only, never prompt text;
// strings a calling agent chose (agent names, repo folder names) are returned under `untrusted`.
import { z } from "zod"
import { flushReports, reportsFor } from "../reporting/hooks.ts"
import type { TaskRecord } from "../reporting/record.ts"
import { summarise, type Group, type GroupBy, type Metrics } from "../reporting/summary.ts"
import { defineTool } from "./define.ts"
import { ok, untrusted } from "./shape.ts"

export const DEFAULT_SINCE_DAYS = 30
export const MAX_SINCE_DAYS = 365
export const MAX_RECENT = 50
/** Review cycle 1: what the numbers cannot show (bridge words only). */
export const NOTES = [
  "groupBy model is the model sent (synapse/auto hides the routed model). groupBy servedModel (#76) is the model Synapse served most of a task's calls, read from front's log when oc_result or a close ran; (unknown) means it was never read, for example a task from before bridge 0.4.0 or one whose box was restarted before any read.",
  "Served models are attributed by the session id the box sends; one session could claim another's, so treat them as a guide.",
  "Token counts are a lower bound: they cover only the messages oc_result fetched.",
]

function row(r: TaskRecord) {
  return {
    key: r.key,
    sessionID: r.sessionID,
    bridge: r.bridge,
    repo: untrusted(r.repo, 128),
    ...(r.agent ? { agent: untrusted(r.agent, 64) } : {}),
    ...(r.requestedModel ? { requestedModel: r.requestedModel } : {}),
    ...(r.servedModels ? { servedModels: r.servedModels } : {}),
    startedAt: r.startedAt,
    sendCount: r.sendCount,
    ...(r.lastSendAt ? { lastSendAt: r.lastSendAt } : {}),
    outcome: r.outcome,
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    ...(r.errorCode ? { errorCode: r.errorCode } : {}),
    ...(r.tokens ? { tokens: r.tokens } : {}),
    ...(r.commitsCollected !== undefined ? { commitsCollected: r.commitsCollected } : {}),
    collected: r.collected,
    disposition: r.disposition,
    ...(r.closedAt ? { closedAt: r.closedAt } : {}),
  }
}

const group = ({ name, ...metrics }: Group) => ({ name: untrusted(name, 128), ...metrics })

const seconds = (ms: number | null) => (ms === null ? "n/a" : `${Math.round(ms / 100) / 10} s`)

function summary(t: Metrics, days: number): string {
  if (!t.tasks) return `No tasks recorded in the last ${days} days.`
  const rate = t.successRate === null ? "no finished tasks yet" : `success rate ${Math.round(t.successRate * 100)}% of ${t.finished} finished`
  const d = t.dispositions
  return (
    `${t.tasks} task${t.tasks === 1 ? "" : "s"} in the last ${days} days: ${t.completed} completed, ${t.error} error, ${t.aborted} aborted, ${t.unknown - t.notSent} unknown, ${t.running} running, ${t.notSent} never sent; ${rate}; ` +
    `duration median ${seconds(t.durationMs.median)}, p90 ${seconds(t.durationMs.p90)}; ${d.collected} collected, ${d.closedDiscarded} discarded, ${d.open} open.`
  )
}

export const reportTool = defineTool({
  name: "oc_report",
  title: "Delegation report",
  description:
    "Report on delegated tasks recorded by the bridges sharing this bridge home: task count, completed / error / aborted / unknown / running, success rate (completed / finished, where finished = completed + error + aborted + unknown; unknown is a run closed or lost before it settled, so it lowers the rate and never raises it; a task never sent is not counted), median and p90 duration (first send to finish), and work collected vs discarded vs still open, overall and per model (the model sent), servedModel (the model Synapse actually served most of each task's calls, #76), agent or repo. " +
    "recent: N adds the newest N task records (metadata only: no prompt or answer text is ever recorded). Agent and repo names are under untrusted; `notes` says what the numbers cannot show. Records older than 90 days, or beyond the newest 2000 (open tasks excepted), are dropped.",
  input: {
    sinceDays: z.number().int().min(1).max(MAX_SINCE_DAYS).optional().describe(`Tasks started in the last N days. Default ${DEFAULT_SINCE_DAYS}.`),
    groupBy: z.enum(["model", "servedModel", "agent", "repo"]).optional().describe("Break the metrics down by model sent (default), servedModel (the model Synapse served most of each task's calls), agent or repo."),
    recent: z.number().int().min(0).max(MAX_RECENT).optional().describe(`Also list the newest N task records. Default 0, at most ${MAX_RECENT}.`),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx) {
    const sinceDays = args.sinceDays ?? DEFAULT_SINCE_DAYS
    const groupBy: GroupBy = args.groupBy ?? "model"
    // Cycle 3: this process's own queued updates first, so the report includes its latest work.
    await flushReports()
    const store = reportsFor(ctx)
    store.prune()
    const report = summarise(store.list(), { sinceDays, groupBy, recent: args.recent ?? 0, now: Date.now() })
    return ok(summary(report.totals, sinceDays), {
      notes: NOTES,
      sinceDays,
      groupBy,
      since: report.since,
      totals: report.totals,
      groups: report.groups.map(group),
      ...(report.recent.length ? { recent: report.recent.map(row) } : {}),
    })
  },
})
