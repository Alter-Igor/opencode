// MOD-03 T3.4: `bun src/cli/watch.ts [--session <id>] [--json]` — one stdout line per attention
// event, for Claude Code's Monitor tool. stdout carries only event lines (CLI-UX-06), `--json`
// makes each line one JSON object (CLI-UX-07), Ctrl-C exits 0 after a bounded cleanup
// (CLI-UX-20), colour only on a TTY without NO_COLOR / TERM=dumb / --no-color (CLI-UX-08).
// The box is found through the supervisor's read-only status(); this never starts or stops it.
import path from "node:path"
import { createHub, type DelegateHub } from "../events/index.ts"
import { defaultConfig } from "../shared/config.ts"
import type { BoxState, HubEvent } from "../shared/contracts.ts"
import { createLogger, scrub } from "../shared/log.ts"
import type { ApiTarget } from "../shared/opencode-api.ts"
import { createSupervisor, defaultSupervisorDeps } from "../supervisor/index.ts"

export const EXIT = { ok: 0, failed: 1, boxDown: 2, notFound: 3, usage: 64 } as const
const STOP_GRACE_MS = 2000

export const HELP = `opencode-delegate watch — print one line per session event that needs attention

Usage: bun src/cli/watch.ts [-s|--session <id>] [--json] [--no-color]

Prints idle, needs_input (permission/question), error, aborted, not_started, server_down,
resync and inbox events. Everything else (and all diagnostics) goes to stderr.

Options:
  -s, --session <id>  Watch one session (default: every session in the sandbox)
      --json          One JSON object per line (the hub event, cursor included)
      --no-color      Plain text even on a terminal
  -h, --help          Show this help

Examples:
  bun src/cli/watch.ts
  bun src/cli/watch.ts --session ses_abc123 --json

Exit codes: 0 stopped (Ctrl-C), 1 unexpected error, 2 sandbox not running or unreachable,
3 session not found, 64 bad arguments.
Docs: docs/implementation/current/FEAT-OCD-001-opencode-delegate-mcp/technical-design.md §6`

export type Args = { kind: "run"; session?: string; json: boolean; noColor: boolean } | { kind: "help" } | { kind: "error"; message: string }

export function parseArgs(argv: string[]): Args {
  const args: Extract<Args, { kind: "run" }> = { kind: "run", json: false, noColor: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h" || a === "--help" || a === "help") return { kind: "help" }
    else if (a === "--json") args.json = true
    else if (a === "--no-color") args.noColor = true
    else if (a === "-s" || a === "--session") {
      const id = argv[++i]
      if (!id || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return { kind: "error", message: `${a} needs a session id such as ses_abc123.` }
      args.session = id
    } else return { kind: "error", message: `Unknown argument: ${a}. Run with --help.` }
  }
  return args
}

const ATTENTION_STATES = new Set(["idle", "needs_input", "error", "aborted", "not_started", "server_down"])

export function isAttention(e: HubEvent): boolean {
  return e.type === "resync" || e.type === "inbox" || (e.state !== undefined && ATTENTION_STATES.has(e.state))
}

const COLOURS: Record<string, string> = { idle: "32", needs_input: "33", resync: "34", inbox: "34" }

export function formatLine(e: HubEvent, options: { json: boolean; color: boolean }): string {
  if (options.json) return JSON.stringify(e)
  const label = e.type === "resync" || e.type === "inbox" ? e.type : (e.state ?? e.type)
  const text = `${e.at} ${label.padEnd(11)} ${e.sessionID ?? "-"} ${e.summary}`
  if (!options.color) return text
  return `\x1b[${COLOURS[label] ?? "31"}m${text}\x1b[0m`
}

export function useColor(isTTY: boolean, env: Record<string, string | undefined>, noColor: boolean): boolean {
  return isTTY && !noColor && !env.NO_COLOR && env.TERM !== "dumb"
}

export type WatchDeps = {
  boxStatus(): Promise<BoxState>
  hub(target: ApiTarget, trackAll: boolean): DelegateHub
  out(line: string): void
  err(line: string): void
  /** Resolve when the user asks to stop (Ctrl-C / SIGTERM). */
  stopped(): Promise<void>
  isTTY: boolean
  env: Record<string, string | undefined>
}

async function findBox(deps: WatchDeps): Promise<ApiTarget | undefined> {
  const box = await deps.boxStatus()
  if (box.state === "running") return box.target
  const why = box.state === "stopped" ? "it is stopped" : `it is unavailable (${box.reason})`
  deps.err(`opencode-delegate watch: the sandbox is not running: ${why}. Start it from the bridge (oc_doctor) and run watch again.`)
  return undefined
}

/** --session: learn the session's directory from the server, then track only it. */
async function trackOne(hub: DelegateHub, sessionID: string, deps: WatchDeps): Promise<number | undefined> {
  const view = await hub.view(sessionID)
  if (view.state === "not_found") {
    deps.err(`opencode-delegate watch: session ${sessionID} was not found in the sandbox.`)
    return EXIT.notFound
  }
  if (view.state === "server_down" || view.state === "unknown") {
    deps.err(`opencode-delegate watch: the sandbox did not answer for ${sessionID} (${view.detail ?? view.state}).`)
    return EXIT.boxDown
  }
  hub.track(sessionID, view.directory)
  deps.err(`opencode-delegate watch: ${sessionID} is ${view.state} now.`)
  return undefined
}

export async function watch(argv: string[], deps: WatchDeps): Promise<number> {
  const args = parseArgs(argv)
  if (args.kind === "help") {
    deps.out(HELP)
    return EXIT.ok
  }
  if (args.kind === "error") {
    deps.err(`opencode-delegate watch: ${args.message}`)
    return EXIT.usage
  }
  deps.err("opencode-delegate watch: looking for the sandbox…")
  const target = await findBox(deps)
  if (!target) return EXIT.boxDown
  const hub = deps.hub(target, args.session === undefined)
  const color = useColor(deps.isTTY, deps.env, args.noColor)
  if (args.session) {
    const code = await trackOne(hub, args.session, deps)
    if (code !== undefined) return code
  }
  hub.subscribe((e) => {
    if (isAttention(e)) deps.out(formatLine(e, { json: args.json, color }))
  })
  await hub.start()
  deps.err(`opencode-delegate watch: watching ${args.session ?? "every session"}; Ctrl-C to stop.`)
  await deps.stopped()
  await Promise.race([hub.stop(), Bun.sleep(STOP_GRACE_MS)])
  return EXIT.ok
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
    out: (line) => void process.stdout.write(line + "\n"),
    err: (line) => void process.stderr.write(line + "\n"),
    stopped: () =>
      new Promise((resolve) => {
        process.once("SIGINT", () => resolve())
        process.once("SIGTERM", () => resolve())
      }),
    isTTY: process.stdout.isTTY === true,
    env: process.env,
  }
}

if (import.meta.main) {
  let code: number
  try {
    code = await watch(process.argv.slice(2), await defaultDeps())
  } catch (error) {
    process.stderr.write(`opencode-delegate watch: unexpected error: ${scrub(error instanceof Error ? error.message : String(error))}\n`)
    code = EXIT.failed
  }
  process.exit(code)
}
