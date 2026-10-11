// MOD-03 T3.4: `bun src/cli/watch.ts [--session <id>] [--json]` — one stdout line per attention
// event, for Claude Code's Monitor tool. stdout carries only event lines (CLI-UX-06), `--json`
// makes each line one JSON object (CLI-UX-07), Ctrl-C exits 0 after a bounded cleanup
// (CLI-UX-20), colour only on a TTY without NO_COLOR / TERM=dumb / --no-color (CLI-UX-08).
// No control character a box could smuggle into an id or summary reaches the terminal (W2C-04).
// The box is found through the supervisor's read-only status(); this never starts or stops it.
import path from "node:path"
import { createHub, ident, type DelegateHub } from "../events/index.ts"
import { defaultConfig } from "../shared/config.ts"
import { BOX_DIRECTORY_RE, SESSION_ID_RE, type BoxState, type HubEvent, type SessionState } from "../shared/contracts.ts"
import { createLogger, scrub } from "../shared/log.ts"
import { DelegateError } from "../shared/errors.ts"
import { createApi, type ApiTarget } from "../shared/opencode-api.ts"
import { createSupervisor, defaultSupervisorDeps } from "../supervisor/index.ts"

export const EXIT = { ok: 0, failed: 1, boxDown: 2, notFound: 3, usage: 64 } as const
const STOP_GRACE_MS = 2000
/** The --once listing cap (the same page size the tools list with). */
const LIST_LIMIT = 200

/**
 * The root-session rows from GET /experimental/session, validated: a non-array answer throws (an
 * unreadable listing is never an empty box), and rows without a well-formed session id or a valid
 * box directory are dropped (W3A-06 / W2C-04 - box data is filtered, not trusted).
 */
export function parseSessionList(data: unknown): Array<{ id: string; directory: string }> {
  if (!Array.isArray(data)) throw new DelegateError("upstream_error", "The delegate server failed to list its sessions.", "Retry; if it repeats, run oc_doctor.", "not an array")
  return data.flatMap((row): Array<{ id: string; directory: string }> => {
    const s = row as { id?: unknown; directory?: unknown }
    if (typeof s.id !== "string" || !SESSION_ID_RE.test(s.id)) return []
    if (typeof s.directory !== "string" || !BOX_DIRECTORY_RE.test(s.directory)) return []
    return [{ id: s.id, directory: s.directory }]
  })
}
/** OpenCode session ids (id/id.ts): the only thing --session accepts. */
export const SESSION_ARG_RE = /^ses_[A-Za-z0-9]{8,64}$/

export const HELP = `opencode-delegate watch — print one line per session event that needs attention

Usage: bun src/cli/watch.ts [-s|--session <id>] [--once] [--json] [--no-color]

Prints idle, needs_input (permission/question), error, aborted, not_started, unknown
(stream gap), server_down and resync events, and a "link" line whenever the event stream
connects, drops or cannot reach the sandbox. Everything else (and all diagnostics) goes to stderr.

Options:
  -s, --session <id>  Watch one session (default: every session in the sandbox)
      --once          One snapshot: print every root session's current state and exit. Opens no
                      stream (no link/cursor events); the read-only view cannot reconstruct a past
                      error/abort - since is when the box last observed the state, observedAt is now.
      --json          One JSON object per line (the hub event, or the snapshot row, as above)
      --no-color      Plain text even on a terminal
  -h, --help          Show this help

Examples:
  bun src/cli/watch.ts
  bun src/cli/watch.ts --once
  bun src/cli/watch.ts --session ses_0123456789abcdefABCDEF --json

Exit codes: 0 stopped (Ctrl-C), 1 unexpected error, 2 sandbox not running or unreachable,
3 session not found, 64 bad arguments.
Docs: docs/implementation/current/FEAT-OCD-001-opencode-delegate-mcp/technical-design.md §6`

export type Args = { kind: "run"; session?: string; once: boolean; json: boolean; noColor: boolean } | { kind: "help" } | { kind: "error"; message: string }

export function parseArgs(argv: string[]): Args {
  const args: Extract<Args, { kind: "run" }> = { kind: "run", once: false, json: false, noColor: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h" || a === "--help" || a === "help") return { kind: "help" }
    else if (a === "--once") args.once = true
    else if (a === "--json") args.json = true
    else if (a === "--no-color") args.noColor = true
    else if (a === "-s" || a === "--session") {
      const id = argv[++i]
      if (!id || !SESSION_ARG_RE.test(id)) return { kind: "error", message: `${a} needs a session id such as ses_0123456789abcdef.` }
      args.session = id
    } else return { kind: "error", message: `Unknown argument: ${clean(a ?? "").slice(0, 40)}. Run with --help.` }
  }
  return args
}

const ATTENTION_STATES = new Set<SessionState>(["idle", "needs_input", "error", "aborted", "not_started", "unknown", "server_down"])

export function isAttention(e: HubEvent): boolean {
  return e.type === "resync" || e.type === "inbox" || e.type === "link" || (e.state !== undefined && ATTENTION_STATES.has(e.state))
}

/** Drop C0, DEL and C1 control characters (terminal escapes) from one output line. */
export function clean(line: string): string {
  return line.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
}

/** JSON.stringify escapes C0 but not DEL/C1: escape those too, so the line stays one safe line of valid JSON. */
function jsonLine(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

const COLOURS: Record<string, string> = { idle: "32", needs_input: "33", resync: "34", inbox: "34", link: "35", unknown: "35" }

export function formatLine(e: HubEvent, options: { json: boolean; color: boolean }): string {
  if (options.json) return jsonLine(e)
  const label = e.type === "resync" || e.type === "inbox" || e.type === "link" ? e.type : (e.state ?? e.type)
  const text = clean(`${e.at} ${label.padEnd(11)} ${e.sessionID === undefined ? "-" : ident(e.sessionID)} ${e.summary}`)
  if (!options.color) return text
  return `\x1b[${COLOURS[label] ?? "31"}m${text}\x1b[0m`
}

export function useColor(isTTY: boolean, env: Record<string, string | undefined>, noColor: boolean): boolean {
  return isTTY && !noColor && !env.NO_COLOR && env.TERM !== "dumb"
}

export type WatchDeps = {
  boxStatus(): Promise<BoxState>
  hub(target: ApiTarget, trackAll: boolean): DelegateHub
  /** The box's root sessions (GET /experimental/session?roots=true): id + a validated box directory. */
  sessions(target: ApiTarget): Promise<Array<{ id: string; directory: string }>>
  out(line: string): void
  err(line: string): void
  /** Resolve when the user asks to stop (Ctrl-C / SIGTERM). */
  stopped(): Promise<void>
  isTTY: boolean
  env: Record<string, string | undefined>
}

type Say = { out(line: string): void; err(line: string): void }

async function findBox(deps: WatchDeps, say: Say): Promise<ApiTarget | undefined> {
  const box = await deps.boxStatus()
  if (box.state === "running") return box.target
  const why = box.state === "stopped" ? "it is stopped" : `it is unavailable (${box.reason})`
  say.err(`opencode-delegate watch: the sandbox is not running: ${why}. Start it from the bridge (oc_doctor) and run watch again.`)
  return undefined
}

/** --session: learn the session's directory from the server, then track only it. Returns the state printed, or an exit code. */
async function trackOne(hub: DelegateHub, sessionID: string, say: Say): Promise<SessionState | number> {
  const view = await hub.view(sessionID)
  if (view.state === "not_found") {
    say.err(`opencode-delegate watch: session ${sessionID} was not found in the sandbox.`)
    return EXIT.notFound
  }
  if (view.state === "server_down" || view.state === "unknown") {
    say.err(`opencode-delegate watch: the sandbox did not answer for ${sessionID} (${view.detail ?? view.state}).`)
    return EXIT.boxDown
  }
  hub.track(sessionID, view.directory)
  say.err(`opencode-delegate watch: ${sessionID} is ${view.state} now.`)
  return view.state
}

/**
 * The state can change between the first read and the stream connecting, and the first connect's
 * rebuild is not published: read again and print the difference (W2A-12).
 */
async function recheck(hub: DelegateHub, sessionID: string, last: SessionState, print: (e: HubEvent) => void, say: Say): Promise<void> {
  const view = await hub.view(sessionID)
  if (view.state === last) return
  say.err(`opencode-delegate watch: ${sessionID} is ${view.state} now.`)
  const at = view.observedAt ?? new Date().toISOString()
  print({ cursor: hub.cursor(), at, type: "status", sessionID, directory: view.directory, state: view.state, summary: `session ${sessionID} is ${view.state} (read after connecting)` })
}

/** A --once snapshot row: one current read of a session. `since` is when the box last observed the
 *  state; `observedAt` is this read. No stream, so no cursor and no past error/abort is recovered. */
type Snapshot = { sessionID: string; directory: string; state: SessionState; since: string; observedAt: string; pending: string[] }

function formatSnapshot(row: Snapshot, options: { json: boolean; color: boolean }): string {
  if (options.json) return jsonLine(row)
  const detail = `${row.sessionID} is ${row.state}${row.pending.length > 0 ? ` (pending ${row.pending.length})` : ""}`
  const text = clean(`${row.observedAt} ${row.state.padEnd(11)} ${row.sessionID} ${detail}`)
  if (!options.color) return text
  return `\x1b[${COLOURS[row.state] ?? "31"}m${text}\x1b[0m`
}

/**
 * One snapshot: every root session (or just the --session one, read directly - absence from the
 * capped root list is not proof of absence). Un-started hub.view reads current state only. A row
 * that came back server_down/unknown makes the whole snapshot exit 2 (never report an incomplete
 * read as clean); an explicit --session that is gone exits 3; a listing that fails is thrown up to
 * the caller (exit 1), never treated as an empty box.
 */
async function runOnce(args: Extract<Args, { kind: "run" }>, deps: WatchDeps, say: Say, target: ApiTarget): Promise<number> {
  const hub = deps.hub(target, false)
  const color = useColor(deps.isTTY, deps.env, args.noColor)
  const read = async (id: string): Promise<SessionState> => {
    const view = await hub.view(id)
    const row: Snapshot = {
      sessionID: id,
      directory: view.directory,
      state: view.state,
      since: view.since,
      observedAt: view.observedAt ?? new Date().toISOString(),
      pending: view.pending ?? [],
    }
    say.out(formatSnapshot(row, { json: args.json, color }))
    return view.state
  }
  if (args.session) {
    const state = await read(args.session)
    if (state === "not_found") return EXIT.notFound
    return state === "server_down" || state === "unknown" ? EXIT.boxDown : EXIT.ok
  }
  let unreliable = false
  for (const session of await deps.sessions(target)) {
    const state = await read(session.id)
    if (state === "server_down" || state === "unknown") unreliable = true
  }
  return unreliable ? EXIT.boxDown : EXIT.ok
}

async function run(args: Extract<Args, { kind: "run" }>, deps: WatchDeps, say: Say): Promise<number> {
  say.err("opencode-delegate watch: looking for the sandbox…")
  const target = await findBox(deps, say)
  if (!target) return EXIT.boxDown
  if (args.once) return runOnce(args, deps, say, target)
  const hub = deps.hub(target, args.session === undefined)
  const color = useColor(deps.isTTY, deps.env, args.noColor)
  let last: SessionState | undefined
  if (args.session) {
    const first = await trackOne(hub, args.session, say)
    if (typeof first === "number") return first
    last = first
  }
  const print = (e: HubEvent) => {
    if (!isAttention(e)) return
    if (e.sessionID === args.session && e.state !== undefined) last = e.state
    say.out(formatLine(e, { json: args.json, color }))
  }
  hub.subscribe(print)
  await hub.start()
  if (args.session && last !== undefined) await recheck(hub, args.session, last, print, say)
  say.err(`opencode-delegate watch: watching ${args.session ?? "every session"}; Ctrl-C to stop.`)
  await deps.stopped()
  await Promise.race([hub.stop(), Bun.sleep(STOP_GRACE_MS)])
  return EXIT.ok
}

export async function watch(argv: string[], deps: WatchDeps): Promise<number> {
  const say: Say = { out: (line) => deps.out(line), err: (line) => deps.err(clean(line)) }
  const args = parseArgs(argv)
  if (args.kind === "help") {
    deps.out(HELP.split("\n").map(clean).join("\n"))
    return EXIT.ok
  }
  if (args.kind === "error") {
    say.err(`opencode-delegate watch: ${args.message}`)
    return EXIT.usage
  }
  return run(args, deps, say)
}

export type SignalSource = {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown
}

/** Resolves on the first SIGINT or SIGTERM, then removes both listeners. */
export function stopSignal(source: SignalSource): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      source.off("SIGINT", done)
      source.off("SIGTERM", done)
      resolve()
    }
    source.once("SIGINT", done)
    source.once("SIGTERM", done)
  })
}

async function defaultDeps(): Promise<WatchDeps> {
  const config = defaultConfig()
  const log = createLogger({ minLevel: "warn" })
  const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..")
  return {
    async boxStatus() {
      // status() only: never ensure()/release(); `permission` is unused by status().
      const deps = await defaultSupervisorDeps(config, { bridgeId: `watch-${process.pid}`, permission: [], repoRoot, log })
      return createSupervisor(deps).status()
    },
    hub: (target, trackAll) => createHub({ target, trackAll, log }),
    async sessions(target) {
      // The same read-only list the tools use (roots = top-level sessions; subagents roll up to
      // their parent). A failed or malformed answer throws via parseSessionList: --once must never
      // report an empty box for a box it could not read.
      const res = await createApi(target).call<unknown>({ path: `/experimental/session?roots=true&limit=${LIST_LIMIT}`, correlationId: "watch" })
      return parseSessionList(res.data)
    },
    out: (line) => void process.stdout.write(line + "\n"),
    err: (line) => void process.stderr.write(line + "\n"),
    stopped: () => stopSignal(process),
    isTTY: process.stdout.isTTY === true,
    env: process.env,
  }
}

if (import.meta.main) {
  let code: number
  try {
    code = await watch(process.argv.slice(2), await defaultDeps())
  } catch (error) {
    process.stderr.write(`opencode-delegate watch: unexpected error: ${clean(scrub(error instanceof Error ? error.message : String(error)))}\n`)
    code = EXIT.failed
  }
  process.exit(code)
}
