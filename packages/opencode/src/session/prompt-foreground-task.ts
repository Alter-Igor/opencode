import { Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { SessionID } from "./schema"

function everyTextPartSynthetic(parts: readonly SessionV1.Part[]) {
  return parts.every((part) => part.type !== "text" || part.synthetic === true)
}

function foregroundTaskJob(job: BackgroundJob.Info, sessionID: string) {
  if (job.status !== "running") return false
  if (job.type !== "task") return false
  if (job.metadata?.background === true) return false
  return job.metadata?.parentSessionId === sessionID
}

// A foreground task holds the parent loop until this job is promoted.
// Synthetic text is not a user check-in. The caller skips noReply.
export const promoteForegroundTask = Effect.fn("SessionPrompt.promoteForegroundTask")(function* (
  jobs: BackgroundJob.Interface,
  sessionID: SessionID,
  parts: readonly SessionV1.Part[],
) {
  if (everyTextPartSynthetic(parts)) return
  const matches = (yield* jobs.list()).filter((job) => foregroundTaskJob(job, sessionID))
  yield* Effect.forEach(matches, (job) => jobs.promote(job.id), { discard: true })
})
