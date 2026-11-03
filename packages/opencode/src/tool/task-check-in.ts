// The check-in reply is only for a job that is still running after promotion.
// A job that finished in the same moment keeps its real result.
export function runningPromotedTask(result: { status?: string; metadata?: { background?: boolean } } | undefined) {
  return result?.metadata?.background === true && result.status === "running"
}
