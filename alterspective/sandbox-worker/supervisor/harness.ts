// #121: the harness check. After the agent claims GOAL_MET, the SERVICE sends hidden acceptance
// tests the agent never saw; root runs them on a private copy of the repo and reports the result
// apart from the agent's claim (svc-coding-agent#4: all 90 runs said GOAL_MET, ~10% failed the
// hidden tests). Pure parts only; `harness-run.ts` does the I/O.
//
// Trust: everything here comes from the service. The agent can write /work/repo and the
// supervisor's state.json, so the box never supplies the command, the tests or the claim.

export const DEFAULT_TIMEOUT_SEC = 600
export const MAX_TIMEOUT_SEC = 3600
export const HARNESS_USER = "sbxwharness"

export type HarnessRequest = {
  taskId: string
  /** The hidden tests as a tar archive (optionally gzipped), written by the service as root. */
  archive: string
  /** SHA-256 of the archive file. */
  sha256: string
  /** Where to unpack the tests, relative to the repo root. Default ".". */
  extractTo: string
  /** The test command, as argv. Run as the harness user in the repo copy. */
  command: string[]
  timeoutSec: number
  /** What the agent said, as the service read it (for example "GOAL_MET"). */
  agentClaim: string
  /** The repo to copy. Default /work/repo. */
  repoDir: string
  /** Freeze the agent's processes (SIGSTOP) while the tests run. Default true. */
  freezeAgent: boolean
}

export type Parsed = { ok: true; request: HarnessRequest } | { ok: false; reason: string }

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function parseHarnessRequest(input: unknown): Parsed {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "request is not an object" }
  const r = input as Record<string, unknown>
  if (typeof r.taskId !== "string" || !TASK_ID.test(r.taskId)) return { ok: false, reason: "taskId is missing or not a safe id" }
  if (typeof r.archive !== "string" || !r.archive.startsWith("/")) return { ok: false, reason: "archive must be an absolute path" }
  if (typeof r.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(r.sha256)) return { ok: false, reason: "sha256 must be 64 hex characters" }
  const extractTo = r.extractTo === undefined ? "." : r.extractTo
  if (typeof extractTo !== "string" || extractTo.startsWith("/") || extractTo.split(/[\\/]/).includes("..")) {
    return { ok: false, reason: "extractTo must be a relative path inside the repo" }
  }
  if (!Array.isArray(r.command) || r.command.length === 0 || r.command.length > 50) return { ok: false, reason: "command must be a non-empty argv array" }
  if (!r.command.every((part) => typeof part === "string" && part.length > 0)) return { ok: false, reason: "command parts must be non-empty strings" }
  const timeoutSec = r.timeoutSec === undefined ? DEFAULT_TIMEOUT_SEC : r.timeoutSec
  if (typeof timeoutSec !== "number" || !Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) {
    return { ok: false, reason: `timeoutSec must be a whole number from 1 to ${MAX_TIMEOUT_SEC}` }
  }
  if (typeof r.agentClaim !== "string") return { ok: false, reason: "agentClaim must be a string (what the service read)" }
  const repoDir = r.repoDir === undefined ? "/work/repo" : r.repoDir
  if (typeof repoDir !== "string" || !repoDir.startsWith("/")) return { ok: false, reason: "repoDir must be an absolute path" }
  if (r.freezeAgent !== undefined && typeof r.freezeAgent !== "boolean") return { ok: false, reason: "freezeAgent must be a boolean" }
  return {
    ok: true,
    request: {
      taskId: r.taskId,
      archive: r.archive,
      sha256: r.sha256.toLowerCase(),
      extractTo,
      command: r.command as string[],
      timeoutSec,
      agentClaim: r.agentClaim,
      repoDir,
      freezeAgent: r.freezeAgent ?? true,
    },
  }
}

export type HarnessOutcome =
  | { ran: true; passed: boolean; exitCode: number | null; timedOut: boolean; durationMs: number; stdoutTail: string; stderrTail: string }
  | { ran: false; error: string }

export type Agreement = "claim-confirmed" | "claim-refuted" | "unclaimed-pass" | "unclaimed-fail" | "harness-error"

/** The agent's claim and the hidden tests are reported apart; this only names how they relate. */
export function classify(agentClaim: string, outcome: HarnessOutcome): Agreement {
  if (!outcome.ran) return "harness-error"
  const claimed = agentClaim.trim().toUpperCase() === "GOAL_MET"
  if (claimed) return outcome.passed ? "claim-confirmed" : "claim-refuted"
  return outcome.passed ? "unclaimed-pass" : "unclaimed-fail"
}

/** A clean environment for the tests: no SBXW_*, no model keys, nothing inherited. */
export function harnessEnv(home: string): Record<string, string> {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    CI: "1",
  }
}

/** The last `max` characters, so a huge test log cannot bloat the result. */
export function tail(text: string, max = 8000): string {
  return text.length <= max ? text : `…${text.slice(-max)}`
}

/**
 * `pkill` exit codes: 0 = signalled, 1 = no matching process (nothing to freeze). Anything else
 * (2/3 = error, 127 = pkill missing) means the freeze did not happen: fail closed.
 */
export function freezeSucceeded(pkillExit: number): boolean {
  return pkillExit === 0 || pkillExit === 1
}

/** 0 = tests passed, 1 = tests failed, 2 = harness error (never a pass). */
export function exitCodeFor(agreement: Agreement, outcome: HarnessOutcome): 0 | 1 | 2 {
  if (agreement === "harness-error" || !outcome.ran) return 2
  return outcome.passed ? 0 : 1
}
