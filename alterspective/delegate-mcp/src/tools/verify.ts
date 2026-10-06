// oc_verify (#142): run an allowlisted verify command against session work on the host.
import path from "node:path"
import { z } from "zod"
import { DelegateError } from "../shared/errors.ts"
import { ownSession, sessionIdSchema } from "./core-session.ts"
import { defineTool } from "./define.ts"
import { ok, untrusted } from "./shape.ts"

export const ALLOWED_BINARIES = new Set([
  "bun",
  "npm",
  "pnpm",
  "yarn",
  "pytest",
  "python",
  "cargo",
  "go",
  "make",
  "gradle",
  "mvn",
  "vitest",
  "jest",
  "oxlint",
  "eslint",
  "tsc",
])

const SHELL_META = /[;&|><`$\n]/

export function parseCommand(raw: string): string[] {
  if (SHELL_META.test(raw)) {
    throw new DelegateError("invalid_input", "Command contains disallowed shell characters.", "Specify command and arguments without chaining or redirection (&, ;, |, >, <, $, `).")
  }
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) {
    throw new DelegateError("invalid_input", "Command cannot be empty.", "Provide a valid verification command.")
  }
  const bin = path.basename(parts[0]!).replace(/\.exe$/i, "").toLowerCase()
  if (!ALLOWED_BINARIES.has(bin)) {
    throw new DelegateError(
      "policy_violation",
      `Executable '${bin}' is not in the verify allowlist.`,
      `Allowed executables are: ${[...ALLOWED_BINARIES].sort().join(", ")}.`,
    )
  }
  return parts
}

export const verifyTool = defineTool({
  name: "oc_verify",
  title: "Run host verification on session work",
  description:
    "Run an allowlisted build/test/typecheck/lint command (bun, npm, pnpm, yarn, pytest, cargo, go, etc.) on the host against a session's collected work. Returns the command's exit code, duration, and trimmed output.",
  input: {
    sessionID: sessionIdSchema,
    command: z.string().min(1).max(1000).describe("The command to run (e.g. 'bun test', 'pnpm run typecheck'). Must use an allowlisted binary."),
    worktree: z.string().min(1).max(500).optional().describe("Host repo or worktree directory to run in. Defaults to the session's host repository."),
    timeoutMs: z.number().int().min(1000).max(600_000).optional().describe("Execution timeout in milliseconds. Default 60,000 (1 minute)."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const box = await ctx.box()
    const { record } = await ownSession(ctx, box, args.sessionID, correlationId)
    const argv = parseCommand(args.command)
    const targetDir = args.worktree ? await ctx.workspaces.resolveRepo(args.worktree) : record.hostRepo
    // Ensure the host has the session's latest commits
    await ctx.workspaces.collect({ sessionKey: record.sessionKey, hostRepo: record.hostRepo, boxPath: record.boxPath, branch: record.branch })
    const began = Date.now()
    const res = await ctx.hostExec(argv, args.timeoutMs ?? 60_000, targetDir)
    const durationMs = Date.now() - began
    const summary = `Command '${args.command}' completed with exit code ${res.code} in ${Math.round(durationMs / 100) / 10} s.`
    return ok(summary, {
      sessionID: record.sessionID,
      command: args.command,
      exitCode: res.code,
      durationMs,
      timedOut: res.timedOut === true,
      stdout: untrusted(res.stdout, 8000),
      stderr: untrusted(res.stderr, 8000),
    })
  },
})
