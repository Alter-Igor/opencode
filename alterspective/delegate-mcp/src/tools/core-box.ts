// MOD-04 core helpers that read files and git state for a session.
//
// Repository instructions (issue B-2): the box runs with OPENCODE_DISABLE_PROJECT_CONFIG, so the
// repo's AGENTS.md / CLAUDE.md no longer reach the agent. oc_send passes them as `system`. They are
// read from the OWNER's repository at the session's base commit (`git cat-file blob <base>:<file>`
// on the host), not from the box clone: the agent can rewrite files in its clone, and text it wrote
// must never be promoted into the system prompt. Repository and base come ONLY from the bridge's
// host record of the session (W3C-01 / W3C-06), never from box metadata.
import { DelegateError } from "../shared/errors.ts"
import { stripUnsafe } from "../shared/text.ts"
import { COMMIT_ID } from "../supervisor/workspaces-state.ts"
import type { SessionRecord, ToolContext } from "./context.ts"
import { hostState } from "./core-session.ts"
import { untrusted } from "./shape.ts"

export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const
/** Total characters of instruction text passed on one send. */
export const MAX_INSTRUCTIONS_CHARS = 32 * 1024
const GIT_TIMEOUT_MS = 20_000

/** `failed`: files the repository has at the base commit that could not be read (never silently "absent"). */
export type Instructions = { system?: string; files: string[]; truncated: boolean; skipped?: string; failed?: string[] }

/** Control, format (bidi, zero-width), tag and invisible filler characters are removed from instruction text (shared/text.ts); tab and newline stay. */
export function cleanInstructionText(text: string): string {
  return stripUnsafe(text.replace(/\r\n/g, "\n")).replace(/\r/g, "")
}

function header(file: string, base: string): string {
  return `Repository instructions: the file ${file} of the repository this session works on, as committed at ${base.slice(0, 12)} (supplied by the opencode-delegate bridge). Follow them as project guidance.\n\n`
}

/** Which instruction files exist at `base` (blobs at the repository root), or undefined when git failed. */
async function presentAt(ctx: ToolContext, repo: string, base: string): Promise<string[] | undefined> {
  const result = await ctx.hostExec(["git", "-C", repo, "ls-tree", "-z", base, "--", ...INSTRUCTION_FILES], GIT_TIMEOUT_MS)
  if (result.code !== 0) return undefined
  const names = result.stdout.split("\u0000").flatMap((line) => {
    const m = /^\d{6} blob [0-9a-f]+\t(.+)$/.exec(line)
    return m?.[1] ? [m[1]] : []
  })
  return INSTRUCTION_FILES.filter((file) => names.includes(file))
}

async function blobAt(ctx: ToolContext, repo: string, base: string, file: string): Promise<string | undefined> {
  const result = await ctx.hostExec(["git", "-C", repo, "cat-file", "blob", `${base}:${file}`], GIT_TIMEOUT_MS)
  return result.code === 0 ? result.stdout : undefined
}

type Source = { repo: string; base: string } | { skipped: string }

async function sourceOf(ctx: ToolContext, record: SessionRecord): Promise<Source> {
  const state = await hostState(ctx, record.sessionKey)
  if (!state || state.sessionID !== record.sessionID) return { skipped: "no host record for this session" }
  if (!COMMIT_ID.test(state.base)) return { skipped: "no recorded base commit" }
  return { repo: state.hostRepo, base: state.base }
}

function assemble(parts: Array<{ file: string; text: string }>, base: string): Pick<Instructions, "system" | "files" | "truncated"> {
  const sections: string[] = []
  const files: string[] = []
  let used = 0
  let truncated = false
  for (const { file, text } of parts) {
    const section = header(file, base) + text
    const room = MAX_INSTRUCTIONS_CHARS - used
    if (room <= 0) {
      truncated = true
      break
    }
    sections.push(section.length > room ? `${section.slice(0, room)}\n[… ${file} truncated by the bridge]` : section)
    truncated ||= section.length > room
    files.push(file)
    used += Math.min(section.length, room)
  }
  return sections.length ? { system: sections.join("\n\n"), files, truncated } : { files, truncated }
}

/** AGENTS.md then CLAUDE.md at the base commit, capped at MAX_INSTRUCTIONS_CHARS in total. */
export async function readInstructions(ctx: ToolContext, record: SessionRecord): Promise<Instructions> {
  const source = await sourceOf(ctx, record)
  if ("skipped" in source) return { files: [], truncated: false, skipped: source.skipped }
  const present = await presentAt(ctx, source.repo, source.base)
  if (!present) return { files: [], truncated: false, failed: [...INSTRUCTION_FILES] }
  const parts: Array<{ file: string; text: string }> = []
  const failed: string[] = []
  for (const file of present) {
    const content = await blobAt(ctx, source.repo, source.base, file)
    if (content === undefined) failed.push(file)
    else if (content.trim()) parts.push({ file, text: cleanInstructionText(content) })
  }
  return { ...assemble(parts, source.base), ...(failed.length ? { failed } : {}) }
}

const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color"]
/**
 * W3C-10: git in the box clone reads the clone's own config, which the agent controls. No global or
 * system config, no fsmonitor or hook program, and no index lock taken for a read.
 */
export const SAFE_BOX_GIT = ["env", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-optional-locks"]

async function boxGit(ctx: ToolContext, record: SessionRecord, args: string[]): Promise<string | undefined> {
  const result = await ctx.boxExec([...SAFE_BOX_GIT, "-C", record.boxPath, ...args], GIT_TIMEOUT_MS)
  if (result.code === 0) return result.stdout
  ctx.log.log("warn", "tools", "box git read failed", { sessionKey: record.sessionKey, code: result.code, timedOut: result.timedOut === true })
  return undefined
}

export type DiffSummary = {
  base?: string
  /** `rev-list --count <base>..refs/heads/delegate/<key>` as the box reports it (W3A-04). oc_collect counts on the host. */
  boxReportedCommits?: number
  /** `git diff --stat <base>` and `git status --porcelain` from the box clone: box output, untrusted. */
  stat?: { text: string; truncated: boolean }
  status?: { text: string; truncated: boolean }
  unavailable?: string
}

export async function diffSummary(ctx: ToolContext, record: SessionRecord): Promise<DiffSummary> {
  const base = record.base
  if (!base || !COMMIT_ID.test(base)) return { unavailable: "no recorded base commit" }
  const [count, stat, status] = await Promise.all([
    boxGit(ctx, record, ["rev-list", "--count", `${base}..refs/heads/${record.branch}`]),
    boxGit(ctx, record, ["diff", "--stat", ...DIFF_FLAGS, base]),
    boxGit(ctx, record, ["status", "--porcelain"]),
  ])
  if (count === undefined && stat === undefined && status === undefined) return { base, unavailable: "the box did not answer the git reads" }
  const commits = /^\d{1,9}$/.test(count?.trim() ?? "") ? Number(count?.trim()) : undefined
  return { base, boxReportedCommits: commits, stat: untrusted(stat, 4000), status: untrusted(status, 4000) }
}

const BUSY = new Set(["starting", "busy", "retry", "needs_input", "unknown"])

/**
 * Refuse a second session in a repository while one of ours there is still working (edge case 7).
 * Advisory only (W3A-13): each session has its own clone, so running two is safe; it only avoids
 * two agents doing the same work by accident.
 */
export async function refuseBusy(ctx: ToolContext, hostRepo: string, same: (a: string, b: string) => boolean): Promise<void> {
  const box = ctx.peekBox()
  if (!box) return
  for (const record of ctx.sessions.values()) {
    if (!same(record.hostRepo, hostRepo)) continue
    const view = await box.hub.view(record.sessionID)
    if (!BUSY.has(view.state)) continue
    throw new DelegateError(
      "directory_busy",
      `Session ${record.sessionID} is still working in this repository (${view.state}).`,
      "Wait for it with oc_wait, stop it with oc_abort, or pass allowShared: true to run both (each session has its own copy).",
    )
  }
}
