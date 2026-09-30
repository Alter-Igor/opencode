// MOD-04 core helpers that read files and git state for a session.
//
// Repository instructions (issue B-2): the box runs with OPENCODE_DISABLE_PROJECT_CONFIG, so the
// repo's AGENTS.md / CLAUDE.md no longer reach the agent. oc_send passes them as `system`. They are
// read from the OWNER's repository at the session's base commit (`git show <base>:<file>` on the
// host), not from the box clone: the agent can rewrite files in its clone, and text it wrote must
// never be promoted into the system prompt. The content is what the box clone started from.
import { DelegateError } from "../shared/errors.ts"
import { COMMIT_ID } from "../supervisor/workspaces.ts"
import type { SessionRecord, ToolContext } from "./context.ts"
import { untrusted } from "./shape.ts"

export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const
/** Total characters of instruction text passed on one send. */
export const MAX_INSTRUCTIONS_CHARS = 32 * 1024
const GIT_TIMEOUT_MS = 20_000

export type Instructions = { system?: string; files: string[]; truncated: boolean; skipped?: string }

function header(file: string, base: string): string {
  return `Repository instructions: the file ${file} of the repository this session works on, as committed at ${base.slice(0, 12)} (supplied by the opencode-delegate bridge). Follow them as project guidance.\n\n`
}

async function showAtBase(ctx: ToolContext, record: SessionRecord, base: string, file: string): Promise<string | undefined> {
  const result = await ctx.hostExec(["git", "-C", record.hostRepo, "show", `${base}:${file}`], GIT_TIMEOUT_MS)
  return result.code === 0 && result.stdout.trim() ? result.stdout : undefined
}

/** AGENTS.md then CLAUDE.md at the base commit, capped at MAX_INSTRUCTIONS_CHARS in total. */
export async function readInstructions(ctx: ToolContext, record: SessionRecord): Promise<Instructions> {
  const base = record.base
  if (!base || !COMMIT_ID.test(base)) return { files: [], truncated: false, skipped: "no recorded base commit" }
  const sections: string[] = []
  const files: string[] = []
  let used = 0
  let truncated = false
  for (const file of INSTRUCTION_FILES) {
    const content = await showAtBase(ctx, record, base, file)
    if (content === undefined) continue
    const section = header(file, base) + content.replace(/\r\n/g, "\n")
    const room = MAX_INSTRUCTIONS_CHARS - used
    if (room <= 0) {
      truncated = true
      break
    }
    const kept = section.length > room ? `${section.slice(0, room)}\n[… ${file} truncated by the bridge]` : section
    truncated ||= section.length > room
    sections.push(kept)
    files.push(file)
    used += Math.min(section.length, room)
  }
  return sections.length ? { system: sections.join("\n\n"), files, truncated } : { files, truncated }
}

/** The box HEAD right after workspaces.open: equal to the base commit (open verifies it). */
export async function boxHead(ctx: ToolContext, boxPath: string): Promise<string | undefined> {
  const result = await ctx.boxExec(["git", "-C", boxPath, "rev-parse", "HEAD"], GIT_TIMEOUT_MS)
  const head = result.stdout.trim()
  return result.code === 0 && COMMIT_ID.test(head) ? head : undefined
}

const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color"]

async function boxGit(ctx: ToolContext, record: SessionRecord, args: string[]): Promise<string | undefined> {
  const result = await ctx.boxExec(["git", "-C", record.boxPath, ...args], GIT_TIMEOUT_MS)
  if (result.code === 0) return result.stdout
  ctx.log.log("warn", "tools", "box git read failed", { sessionKey: record.sessionKey, code: result.code, timedOut: result.timedOut === true })
  return undefined
}

export type DiffSummary = {
  base?: string
  commits?: number
  /** `git diff --stat <base>` and `git status --porcelain` from the box clone: box output, untrusted. */
  stat?: { text: string; truncated: boolean }
  status?: { text: string; truncated: boolean }
  unavailable?: string
}

export async function diffSummary(ctx: ToolContext, record: SessionRecord): Promise<DiffSummary> {
  const base = record.base
  if (!base || !COMMIT_ID.test(base)) return { unavailable: "no recorded base commit" }
  const [count, stat, status] = await Promise.all([
    boxGit(ctx, record, ["rev-list", "--count", `${base}..HEAD`]),
    boxGit(ctx, record, ["diff", "--stat", ...DIFF_FLAGS, base]),
    boxGit(ctx, record, ["status", "--porcelain"]),
  ])
  if (count === undefined && stat === undefined && status === undefined) return { base, unavailable: "the box did not answer the git reads" }
  const commits = Number(count?.trim())
  return { base, commits: Number.isInteger(commits) ? commits : undefined, stat: untrusted(stat, 4000), status: untrusted(status, 4000) }
}

const BUSY = new Set(["starting", "busy", "retry", "needs_input", "unknown"])

/** Refuse a second session in a repository while one of ours there is still working (edge case 7). */
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
      "Wait for it with oc_wait, stop it with oc_abort, or pass allowShared: true to run both.",
    )
  }
}
