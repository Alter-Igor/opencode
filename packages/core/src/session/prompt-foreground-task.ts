import { Effect } from "effect"
import type { Session } from "../session.js"

export type PartLike = { type: string; synthetic?: boolean; [key: string]: unknown }
export type JobLike = {
  id: string
  status: string
  type: string
  metadata?: { background?: boolean; parentSessionId?: string; [key: string]: unknown }
}
export type JobServiceLike = {
  list: () => Effect.Effect<readonly JobLike[]>
  promote: (id: string) => Effect.Effect<unknown>
}

export function onlySyntheticText(parts: readonly PartLike[]) {
  if (parts.length === 0) return false
  return parts.every((part) => part.type === "text" && part.synthetic === true)
}

export function foregroundTaskJob(job: JobLike, sessionID: string) {
  if (job.status !== "running") return false
  if (job.type !== "task") return false
  if (job.metadata?.background === true) return false
  return job.metadata?.parentSessionId === sessionID
}

export const promoteForegroundTask = Effect.fn("SessionPrompt.promoteForegroundTask")(function* (
  jobs: JobServiceLike,
  sessionID: Session.ID | string,
  parts: readonly PartLike[],
) {
  if (onlySyntheticText(parts)) return
  const matches = (yield* jobs.list()).filter((job) => foregroundTaskJob(job, String(sessionID)))
  yield* Effect.forEach(matches, (job) => jobs.promote(job.id), { discard: true })
})
