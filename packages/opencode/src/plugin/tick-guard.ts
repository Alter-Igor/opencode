// Fork-only (#267): a scheduled tick or goal-loop continue must not write a user
// row while the session is busy, or while a real user message has no reply yet.

export type TickStatus = "idle" | "busy" | "retry"
export type TickChildStatus = "working" | "idle" | "failed"

export type TickChild = {
  id: string
  status: TickChildStatus
}

export type TickMessage = {
  info: {
    role: string
    synthetic?: boolean
  }
  parts?: { synthetic?: boolean }[]
}

export type TickDecision = { send: true } | { send: false; reason: "busy" | "unanswered" }

// A user row is synthetic when it says so, or when every part is. No parts means a real user row.
function isRealUser(message: TickMessage) {
  if (message.info.role !== "user") return false
  if (message.info.synthetic === true) return false
  const parts = message.parts ?? []
  if (parts.length === 0) return true
  return parts.some((part) => part.synthetic !== true)
}

export function shouldSendTick(input: { status: TickStatus; messages: TickMessage[] }): TickDecision {
  if (input.status !== "idle") return { send: false, reason: "busy" }
  const lastReal = input.messages.findLastIndex(isRealUser)
  if (lastReal === -1) return { send: true }
  const answered = input.messages.slice(lastReal + 1).some((message) => message.info.role === "assistant")
  if (!answered) return { send: false, reason: "unanswered" }
  return { send: true }
}

// busy/retry is still working. An idle child with an error failed. Anything else is idle.
export function childTickStatus(status: { type?: string; error?: unknown } | undefined): TickChildStatus {
  if (status?.type === "busy" || status?.type === "retry") return "working"
  if (status?.type === "idle" && status.error) return "failed"
  return "idle"
}

function childSummary(children: TickChild[]) {
  const working = children.filter((child) => child.status === "working").length
  const idle = children.filter((child) => child.status === "idle").length
  const failed = children.filter((child) => child.status === "failed").length
  return `${working} working, ${idle} idle, ${failed} failed`
}

export function factsLine(input: { status: TickStatus; children: TickChild[] }) {
  return `[tick] status=${input.status} children=${childSummary(input.children)}`
}

export function skipToast(reason: "busy" | "unanswered", children: TickChild[]) {
  const counts = `Children: ${childSummary(children)}.`
  if (reason === "busy") return `Tick skipped, session busy. ${counts}`
  return `Tick skipped, a message is still waiting. ${counts}`
}
