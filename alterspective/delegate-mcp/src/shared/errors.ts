// Stable error codes for every bridge failure (technical-design.md §8).
// `message` is safe to show an AI client or a person; `detail` is for logs only (ERR-SPLIT-01).
// Neither may contain secrets, tokens or stack traces (ERR-MSG-03).

export const ErrorCode = [
  "server_down",
  // HTTP 401 from the box: the bridge and the box disagree on the server password (review A-08).
  "auth_mismatch",
  "sandbox_unavailable",
  "profile_invalid",
  "profile_changed",
  "policy_violation",
  "policy_unverified",
  "needs_auth",
  "port_busy",
  "directory_invalid",
  "directory_busy",
  // collect: the host's delegate/<key> and the box's are not a fast-forward; nothing was overwritten.
  "branch_diverged",
  // collect: the box's out-bundle is over the size cap (WorkspacesOptions.maxBundleBytes).
  "bundle_too_large",
  "not_found",
  "not_started",
  "cursor_expired",
  "inbox_unavailable",
  "upstream_error",
  "invalid_input",
] as const

export type ErrorCode = (typeof ErrorCode)[number]

export class DelegateError extends Error {
  readonly code: ErrorCode
  readonly action: string
  readonly detail: string | undefined

  constructor(code: ErrorCode, message: string, action: string, detail?: string) {
    super(message)
    this.name = "DelegateError"
    this.code = code
    this.action = action
    this.detail = detail
  }

  toResult() {
    return { code: this.code, message: this.message, action: this.action }
  }
}

export function isDelegateError(value: unknown): value is DelegateError {
  return value instanceof DelegateError
}
