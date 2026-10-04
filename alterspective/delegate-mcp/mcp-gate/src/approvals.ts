// #104: one-time approvals for gated tool calls.
//
// The gate never holds a box request open while a person decides (an MCP client gives up long
// before). It answers the call with "needs approval <id>" at once and records the call here. When
// the delegating agent or the owner approves it (bridge oc_answer -> admin API), the SAME call
// (same tool, same arguments) succeeds once, if the box retries it within the approval window.
// A different call, a second retry, or a retry after the window needs a new approval.
//
// Memory only: a gate restart forgets every approval, which only means asking again.
import { createHash, randomUUID } from "node:crypto"

export const APPROVAL_TTL_MS = 30 * 60_000
export const MAX_APPROVALS = 500
/** Bounded preview of the arguments, for the person deciding. Untrusted: written by the box. */
export const PREVIEW_CHARS = 600

export type ApprovalState = "pending" | "approved" | "denied" | "used" | "expired"

export type Approval = {
  id: string
  toolName: string
  reason: string
  argumentsPreview: string
  createdAt: number
  decidedAt?: number
  state: ApprovalState
  digest: string
}

/** The view the admin API returns (no digest). */
export type ApprovalView = Omit<Approval, "digest">

/** Stable JSON: object keys sorted, so the same arguments always give the same digest. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

export const callDigest = (toolName: string, args: unknown) => createHash("sha256").update(`${toolName}\n${canonical(args ?? {})}`).digest("hex")

export class ApprovalStore {
  private readonly items = new Map<string, Approval>()
  constructor(private readonly now: () => number = Date.now) {}

  private sweep(): void {
    const now = this.now()
    for (const item of this.items.values()) {
      if ((item.state === "pending" || item.state === "approved") && now - (item.decidedAt ?? item.createdAt) > APPROVAL_TTL_MS) item.state = "expired"
    }
    // Oldest finished entries go first when the store is full.
    if (this.items.size <= MAX_APPROVALS) return
    for (const [id, item] of this.items) {
      if (this.items.size <= MAX_APPROVALS) break
      if (item.state !== "pending" && item.state !== "approved") this.items.delete(id)
    }
  }

  /**
   * The gate's question for one call: true when an approval for exactly this call is waiting to be
   * used (it is then consumed), else false after recording (or reusing) a pending approval.
   */
  check(toolName: string, args: unknown, reason: string): { approved: true } | { approved: false; approval: ApprovalView } {
    this.sweep()
    const digest = callDigest(toolName, args)
    for (const item of this.items.values()) {
      if (item.digest !== digest) continue
      if (item.state === "approved") {
        item.state = "used"
        return { approved: true }
      }
      // A refusal stands for the approval window: retrying the same call does not ask again.
      if (item.state === "pending" || (item.state === "denied" && this.now() - (item.decidedAt ?? item.createdAt) <= APPROVAL_TTL_MS))
        return { approved: false, approval: view(item) }
    }
    if (this.items.size >= MAX_APPROVALS && [...this.items.values()].every((i) => i.state === "pending" || i.state === "approved"))
      throw new Error("too many open approvals")
    const preview = canonical(args ?? {})
    const item: Approval = {
      id: `apr_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      toolName,
      reason,
      argumentsPreview: preview.length > PREVIEW_CHARS ? `${preview.slice(0, PREVIEW_CHARS)}...` : preview,
      createdAt: this.now(),
      state: "pending",
      digest,
    }
    this.items.set(item.id, item)
    return { approved: false, approval: view(item) }
  }

  list(state?: ApprovalState): ApprovalView[] {
    this.sweep()
    return [...this.items.values()].filter((item) => state === undefined || item.state === state).map(view)
  }

  /** Approve or deny a pending approval. Returns the new view, or undefined when it is not pending. */
  decide(id: string, decision: "approve" | "deny"): ApprovalView | undefined {
    this.sweep()
    const item = this.items.get(id)
    if (item === undefined || item.state !== "pending") return undefined
    item.state = decision === "approve" ? "approved" : "denied"
    item.decidedAt = this.now()
    return view(item)
  }
}

function view(item: Approval): ApprovalView {
  const { digest: _digest, ...rest } = item
  return { ...rest }
}
