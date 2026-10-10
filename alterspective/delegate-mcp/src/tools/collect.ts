// oc_collect (technical-design §4): fetch the session branch back into the owner's repository as
// delegate/<key>. Nothing is merged or checked out; the owner reviews the branch like a PR. Files
// the agent changed that the host could execute (hooks, scripts, CI) are flagged loudly.
// D6 (owner decision 2026-10-10): `verify` runs allowlisted commands in the box workspace after
// the fetch and reports the exit codes the BRIDGE observed. A delegated agent's "tests passed" is
// a claim; an exit code is evidence (live finding: a builder reported 62 passing while the owner's
// full run found 10 failures the partial run missed). The branch is fetched either way - a failed
// verify is a loud warning with evidence, never a lost session.
import { z } from "zod"
import { recordCollect } from "../reporting/hooks.ts"
import { DelegateError } from "../shared/errors.ts"
import type { Box, SessionRecord, ToolContext } from "./context.ts"
import { defineTool } from "./define.ts"
import { ownSession, ownedStates, recordFromState, sessionIdSchema } from "./core-session.ts"
import { ok, untrusted } from "./shape.ts"
import { parseCommand } from "./verify.ts"

export const MAX_VERIFY_COMMANDS = 20
export const VERIFY_TIMEOUT_MS = 120_000
export const MAX_VERIFY_TIMEOUT_MS = 600_000

/**
 * #72: the record to collect from. When the sandbox no longer has the session (HTTP 404) but this
 * bridge's host record for this box still names it, e.g. after oc_close_session kept the copy
 * because work appeared while closing and the bridge then restarted, the copy is collected from the
 * host record. Collect needs only the clone, never the OpenCode session.
 */
async function collectRecord(ctx: ToolContext, box: Box, sessionID: string, correlationId: string): Promise<SessionRecord> {
  try {
    return (await ownSession(ctx, box, sessionID, correlationId)).record
  } catch (error) {
    if (!(error instanceof DelegateError) || error.code !== "not_found" || error.detail !== "HTTP 404") throw error
    const state = (await ownedStates(ctx)).find((s) => s.sessionID === sessionID && s.boxProject === ctx.config.project)
    if (!state) throw error
    return recordFromState(ctx, state)
  }
}

export type VerifyRow = { command: string; exitCode: number; timedOut: boolean; durationMs: number; stdout: { text: string; truncated: boolean }; stderr: { text: string; truncated: boolean } }

/**
 * D6: run each allowlisted command in the box workspace (where delegate/<key> is checked out;
 * the host working tree is the owner's branch, so host-side checks would test the wrong tree).
 * The bridge reads exit codes itself - the agent's claim never enters this path.
 */
export async function runVerify(ctx: ToolContext, record: SessionRecord, argvs: readonly string[][], commands: readonly string[], timeoutMs: number): Promise<VerifyRow[]> {
  const rows: VerifyRow[] = []
  for (let i = 0; i < argvs.length; i++) {
    const began = Date.now()
    const res = await ctx.boxExec(argvs[i]!, timeoutMs, record.boxPath)
    rows.push({ command: commands[i]!, exitCode: res.code, timedOut: res.timedOut === true, durationMs: Date.now() - began, stdout: untrusted(res.stdout, 4000) ?? { text: "", truncated: false }, stderr: untrusted(res.stderr, 4000) ?? { text: "", truncated: false } })
  }
  return rows
}

function verifySummary(rows: readonly VerifyRow[]): string {
  const failed = rows.filter((r) => r.exitCode !== 0)
  if (failed.length === 0) return ` Verification: ${rows.length} command(s) passed (exit codes observed by the bridge in the box).`
  return `VERIFICATION FAILED (${failed.length} of ${rows.length} command(s) exited non-zero) - treat any "tests passed" claim from this session as unproven: ${failed.map((r) => `${r.command} -> exit ${r.exitCode}${r.timedOut ? " (timeout)" : ""}`).join("; ")}.`
}

export const collectTool = defineTool({
  name: "oc_collect",
  title: "Collect a session's branch",
  description:
    "Fetch the session's branch (delegate/<key>) into the owner's repository. Nothing is merged or checked out. Warns when the agent changed files the host could execute (git hooks, scripts, CI config): review those before running anything. `verify` runs allowlisted commands (bun test, pytest, ...) in the box workspace and reports the exit codes the bridge observed - evidence instead of the agent's word (D6). A failed verify still fetches the branch, loudly marked.",
  input: {
    sessionID: sessionIdSchema,
    verify: z.array(z.string().min(1).max(1000)).max(MAX_VERIFY_COMMANDS).optional().describe("Commands to run in the session's box workspace after the fetch (e.g. ['bun install', 'bun test']). Allowlisted binaries only; no shell metacharacters."),
    verifyTimeoutMs: z.number().int().min(1000).max(MAX_VERIFY_TIMEOUT_MS).optional().describe(`Per-command timeout. Default ${VERIFY_TIMEOUT_MS / 1000} s.`),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    // Validate every command first: a disallowed or unsafe one refuses before the fetch, so a
    // half-run collect never happens (same parseCommand policy as oc_verify and oc_land).
    const argvs = args.verify?.map(parseCommand)
    const box = await ctx.box()
    const record = await collectRecord(ctx, box, args.sessionID, correlationId)
    const result = await ctx.workspaces.collect({ sessionKey: record.sessionKey, hostRepo: record.hostRepo, boxPath: record.boxPath, branch: record.branch })
    recordCollect(ctx, record, result.commits)
    const rows = argvs?.length ? await runVerify(ctx, record, argvs, args.verify ?? [], args.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS) : undefined
    const risky = result.hostExecutableChanges
    const warning = risky.length
      ? `WARNING: ${risky.length} changed file${risky.length === 1 ? "" : "s"} can run on the host (hooks, scripts or CI). Review them before running anything from ${result.branch}.`
      : undefined
    const summary = `${result.branch} fetched into the owner's repo with ${result.commits} commit${result.commits === 1 ? "" : "s"}.${warning ? ` ${warning}` : ""}${rows ? ` ${verifySummary(rows)}` : ""}`
    return ok(summary, {
      sessionID: record.sessionID,
      hostRepo: record.hostRepo,
      branch: result.branch,
      commits: result.commits,
      hostExecutableChanges: { count: risky.length, ...(warning ? { warning, paths: untrusted(risky.join("\n"), 4000) } : {}) },
      ...(rows ? { verify: { passed: rows.every((r) => r.exitCode === 0), rows } } : {}),
    })
  },
})
