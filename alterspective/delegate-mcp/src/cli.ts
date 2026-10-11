#!/usr/bin/env bun
// opencode-delegate CLI (bin). `mcp` (default) is the stdio MCP server: in that mode stdout carries
// MCP frames only, so every console method that writes to stdout is sent to stderr (W3A-18) and
// logs go to stderr + <home>/logs (D-1).
// Exit codes (CLI-UX-22): 0 ok, 1 error, 2 bad arguments; `watch` passes on its own codes.
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { renameSync, unlinkSync } from "node:fs"
import path from "node:path"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { isDelegateError } from "./shared/errors.ts"
import { scrub } from "./shared/log.ts"
import { flushReports, reportsFor } from "./reporting/hooks.ts"
import { outcomeRows } from "./reporting/export.ts"
import { parseScorecardSnapshot, scorecard, scoreDelta, type ModelScore, type Scorecard } from "./reporting/scorecard.ts"
import { createRuntime, readVersion, shutdownSignal, type Runtime, type VersionInfo } from "./runtime.ts"
import { createServer } from "./server.ts"
import { doctorTool } from "./tools/doctor.ts"
import { loginTool } from "./tools/login.ts"

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const

export const HELP = `opencode-delegate — delegate coding work to sandboxed OpenCode sessions over MCP

Usage:
  opencode-delegate [mcp] [--channels]   Run the stdio MCP server (what an AI client starts)
  opencode-delegate watch [options]      One line per session event that needs attention (see: watch --help)
  opencode-delegate doctor               Print the oc_doctor report as JSON (never starts the sandbox; exit 1 unless verified)
  opencode-delegate login synapse        Sign in to Synapse on this computer (browser), like oc_login {server:"synapse"}
  opencode-delegate outcomes [--days N] [--no-redact]
                                         Settled task outcomes as JSONL on stdout (benchmark material, D7):
                                         one line per finished task - models that served it, outcome,
                                         duration, tokens, collected/discarded. Repo/caller names are
                                         hashed unless --no-redact. Never starts the sandbox.
  opencode-delegate scorecard [--days N] [--json]
                                         Per-model scorecard table plus what moved since the last run
                                         (the loop check-in): success-rate and task-count changes, new
                                         and gone models, new ghosts. Saves a snapshot under the bridge
                                         home; the first run shows the table only. Never starts the sandbox.
  opencode-delegate --version [--json]   Print the version
  opencode-delegate -h | --help | help   Show this help

Options:
      --channels   mcp: push session events to Claude Code as channel notifications
      --json       --version: one JSON object {version, package, sha, dirty, built}

Environment:
  OPENCODE_DELEGATE_NAME    Bridge name (a-z, 0-9, '-'; default claude-<random>); a fixed name lets a
                            restarted bridge adopt its own sessions
  OPENCODE_DELEGATE_ROOTS   ';'-separated folders sessions may start from (default C:\\GitHub)
  OPENCODE_DELEGATE_HOME    Bridge state and logs (default ~/.local/share/opencode-delegate)
  OPENCODE_DELEGATE_PROJECT Docker compose project (default opencode-delegate); a separate box per project

Examples:
  claude mcp add opencode-delegate -- bun C:\\GitHub\\opencode\\alterspective\\delegate-mcp\\src\\cli.ts mcp
  opencode-delegate doctor
  opencode-delegate --version --json

Exit codes: 0 ok, 1 error, 2 bad arguments (watch: see watch --help).
Docs: docs/implementation/current/FEAT-OCD-001-opencode-delegate-mcp/technical-design.md`

export type Command =
  | { kind: "mcp"; channels: boolean }
  | { kind: "watch"; args: string[] }
  | { kind: "doctor" }
  | { kind: "login"; server: "synapse" }
  | { kind: "outcomes"; days: number; redact: boolean }
  | { kind: "scorecard"; days: number; json: boolean }
  | { kind: "version"; json: boolean }
  | { kind: "help" }
  | { kind: "error"; message: string }

const printable = (value: string) => value.replace(/[^\x20-\x7E]/g, "?").slice(0, 40)

function parseFlags(rest: string[], allowed: string[]): { flags: Set<string> } | { error: string } {
  const flags = new Set<string>()
  for (const arg of rest) {
    if (!allowed.includes(arg)) return { error: `Unknown argument: ${printable(arg)}. Run with --help.` }
    flags.add(arg)
  }
  return { flags }
}

export function parseCli(argv: string[]): Command {
  const [first, ...rest] = argv
  if (first === "-h" || first === "--help" || first === "help") return { kind: "help" }
  if (first === "watch") return { kind: "watch", args: rest }
  const [command, flagArgs] = first === undefined || first.startsWith("--") ? ["mcp", argv] : [first, rest]
  if (command === "mcp" && flagArgs.some((a) => a === "--version")) {
    const parsed = parseFlags(flagArgs, ["--version", "--json"])
    return "error" in parsed ? { kind: "error", message: parsed.error } : { kind: "version", json: parsed.flags.has("--json") }
  }
  if (flagArgs.some((a) => a === "-h" || a === "--help")) return { kind: "help" }
  if (command === "mcp") {
    const parsed = parseFlags(flagArgs, ["--channels"])
    return "error" in parsed ? { kind: "error", message: parsed.error } : { kind: "mcp", channels: parsed.flags.has("--channels") }
  }
  if (command === "doctor") {
    const parsed = parseFlags(flagArgs, [])
    return "error" in parsed ? { kind: "error", message: parsed.error } : { kind: "doctor" }
  }
  if (command === "login") return flagArgs.length === 1 && flagArgs[0] === "synapse" ? { kind: "login", server: "synapse" } : { kind: "error", message: "Usage: login synapse" }
  if (command === "outcomes") return parseOutcomes(flagArgs)
  if (command === "scorecard") return parseScorecard(flagArgs)
  return { kind: "error", message: `Unknown command: ${printable(command)}. Run with --help.` }
}

const MAX_OUTCOME_DAYS = 365

function parseOutcomes(args: string[]): Command {
  let days = 90
  let redact = true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--no-redact") { redact = false; continue }
    if (arg === "--days") {
      const value = Number(args[++i])
      if (!Number.isInteger(value) || value < 1 || value > MAX_OUTCOME_DAYS) return { kind: "error", message: "--days needs an integer 1..365" }
      days = value
      continue
    }
    return { kind: "error", message: `Unknown argument: ${printable(arg)}. Run with --help.` }
  }
  return { kind: "outcomes", days, redact }
}

function parseScorecard(args: string[]): Command {
  let days = 30
  let json = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--json") { json = true; continue }
    if (arg === "--days") {
      const value = Number(args[++i])
      if (!Number.isInteger(value) || value < 1 || value > MAX_OUTCOME_DAYS) return { kind: "error", message: "--days needs an integer 1..365" }
      days = value
      continue
    }
    return { kind: "error", message: `Unknown argument: ${printable(arg)}. Run with --help.` }
  }
  return { kind: "scorecard", days, json }
}

export type Io = { out(text: string): void; err(text: string): void }

const processIo: Io = { out: (text) => void process.stdout.write(text + "\n"), err: (text) => void process.stderr.write(text + "\n") }

export function formatVersion(info: VersionInfo, json: boolean): string {
  return json ? JSON.stringify(info) : `opencode-delegate ${info.version}`
}

type ConsoleLike = Pick<Console, "log" | "info" | "debug" | "dir" | "table" | "trace" | "warn" | "error">

/** W3A-18: anything a dependency prints must not corrupt the MCP stream on stdout. */
export function redirectConsole(target: ConsoleLike = console, write: (text: string) => void = (text) => void process.stderr.write(text)): void {
  const toErr = (...args: unknown[]) => write(`${args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" ")}\n`)
  target.log = toErr
  target.info = toErr
  target.debug = toErr
  target.dir = (item: unknown) => toErr(item)
  target.table = (data: unknown) => toErr(data)
  target.trace = (...args: unknown[]) => toErr(...args, new Error("trace").stack ?? "")
  target.warn = toErr
  target.error = toErr
}

async function runMcp(channels: boolean): Promise<number> {
  redirectConsole()
  const runtime = await createRuntime()
  const { server, close } = createServer(runtime.ctx, { channels })
  const stopped = shutdownSignal(process)
  await server.connect(new StdioServerTransport())
  runtime.ctx.log.log("info", "cli", "MCP server listening on stdio", { bridge: runtime.name, channels })
  // WS2 (#48): renew the owner's Synapse token on the host while this bridge runs.
  const stopRefresh = runtime.synapse?.start() ?? (() => {})
  // #67 step 4: with OCD_KEYSTONE_HOST_AUTH=1, renew the owner's Keystone connection tokens too.
  const stopKeystone = runtime.keystone?.start() ?? (() => {})
  const reason = await stopped
  stopKeystone()
  stopRefresh()
  await close().catch(() => undefined)
  await runtime.shutdown(reason)
  return EXIT.ok
}

/** Exit 0 only when every doctor check ran and passed (W3A-09). */
export async function runDoctor(io: Io, make: () => Promise<Runtime> = createRuntime): Promise<number> {
  const runtime = await make()
  try {
    const result = await doctorTool.run({}, runtime.ctx, runtime.ctx.correlationId())
    io.out(JSON.stringify(result.structuredContent ?? {}, null, 2))
    return !result.isError && result.structuredContent?.verified === true ? EXIT.ok : EXIT.failed
  } finally {
    await runtime.shutdown("doctor done")
  }
}

/** `login synapse`: the host sign-in, printed as the oc_login result (never a token). */
export async function runLogin(io: Io, make: () => Promise<Runtime> = createRuntime): Promise<number> {
  const runtime = await make()
  try {
    const result = await loginTool.run({ server: "synapse" }, runtime.ctx, runtime.ctx.correlationId())
    io.out(JSON.stringify(result.structuredContent ?? {}, null, 2))
    return result.isError ? EXIT.failed : EXIT.ok
  } finally {
    await runtime.shutdown("login done")
  }
}

/** The redaction salt: random per bridge home, kept on disk so hashed names stay stable across runs. */
async function reportSalt(home: string): Promise<string> {
  const file = path.join(home, "report-salt")
  const existing = await Bun.file(file).text().catch(() => "")
  if (/^[a-f0-9]{32,}$/.test(existing.trim())) return existing.trim()
  const salt = randomBytes(16).toString("hex")
  await Bun.write(file, salt)
  return salt
}

/** D7: settled task outcomes as JSONL on stdout (one line per row); exit 0 even when there are none. */
export async function runOutcomes(io: Io, days: number, redact: boolean, make: () => Promise<Runtime> = createRuntime): Promise<number> {
  const runtime = await make()
  try {
    await flushReports()
    const records = reportsFor(runtime.ctx).list()
    const rows = outcomeRows(records, { now: Date.now(), days, salt: await reportSalt(runtime.ctx.config.home), redactNames: redact })
    for (const row of rows) io.out(JSON.stringify(row))
    io.err(`opencode-delegate: ${rows.length} outcome row(s) of ${records.length} record(s) (last ${days}d, ${redact ? "names hashed" : "names verbatim"})`)
    return EXIT.ok
  } finally {
    await runtime.shutdown("outcomes done")
  }
}

const SNAPSHOT_FILE = "scorecard-last.json"
const SNAPSHOT_RETRY_MS = [20, 40, 80, 160]

/** The previous run's scorecard, or null (first run, unreadable or corrupt file - the delta is
 *  reporting only, so a bad snapshot must never fail the command). */
async function loadSnapshot(home: string): Promise<Scorecard | null> {
  const text = await Bun.file(path.join(home, SNAPSHOT_FILE)).text().catch(() => "")
  if (!text) return null
  return parseScorecardSnapshot(safeSnapshotJson(text))
}

function safeSnapshotJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** temp file + rename (the store.ts pattern, whole-file only): a crash leaves a stale .tmp, never a
 *  torn snapshot; a Windows EPERM/EBUSY on the rename (an antivirus or reader holding the file) is
 *  retried with backoff. Failure is reported, never thrown. */
async function saveSnapshot(home: string, current: Scorecard): Promise<string | undefined> {
  const file = path.join(home, SNAPSHOT_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await Bun.write(tmp, JSON.stringify(current))
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, file)
        return undefined
      } catch (error) {
        const code = (error as { code?: string }).code
        if (attempt >= SNAPSHOT_RETRY_MS.length || code === undefined || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw error
        await Bun.sleep(SNAPSHOT_RETRY_MS[attempt]!)
      }
    }
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // already gone
    }
    return (error as { code?: string }).code ?? "write failed"
  }
}

const pct = (rate: number | null): string => (rate === null ? "-" : `${Math.round(rate * 100)}%`)
const n1 = (value: number): string => (value >= 10 ? value.toFixed(0) : value.toFixed(1))

function fmtMs(ms: number | null): string {
  if (ms === null) return "-"
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

export function formatScorecardTable(card: Scorecard): string[] {
  const header = "model".padEnd(28) + "kind".padEnd(15) + "tasks".padStart(7) + "rate".padStart(6) + "med".padStart(8) + "p90".padStart(8) + "err".padStart(6)
  const rows = card.models.map((m: ModelScore) =>
    m.model.padEnd(28) + m.kind.padEnd(15) + n1(m.tasks).padStart(7) + pct(m.successRate).padStart(6) + fmtMs(m.medianMs).padStart(8) + fmtMs(m.p90Ms).padStart(8) + (m.error >= 1 ? n1(m.error).padStart(6) : m.error > 0 ? "<1".padStart(6) : "".padStart(6)),
  )
  return [`scorecard (last ${card.days}d, ${card.tasks} tasks, since ${card.since.slice(0, 10)}):`, header, ...rows]
}

export function formatDelta(delta: ReturnType<typeof scoreDelta>): string[] {
  if (delta.firstRun) return ["delta: none yet (first run - snapshot saved, the next run compares)."]
  if (delta.windowMismatch) return [`delta: none (last run used --days ${delta.daysFrom}; the window must match to compare).`]
  if (delta.lines.length === 0) return ["delta: nothing moved."]
  return [
    `delta vs snapshot (${delta.daysFrom}d window):`,
    ...delta.lines.map((d) => {
      const tag = d.kind === "requested-only" ? "ghost " : ""
      if (d.new) return `  ${tag}${d.model} NEW: ${n1(d.tasksTo)} tasks${d.lowN ? " (low n)" : ""}`
      if (d.gone) return `  ${tag}${d.model} GONE (was ${pct(d.rateFrom)}, ${n1(d.tasksFrom)} tasks)`
      return `  ${tag}${d.model} rate ${pct(d.rateFrom)} → ${pct(d.rateTo)}  tasks ${n1(d.tasksFrom)} → ${n1(d.tasksTo)}${d.lowN ? " (low n)" : ""}`
    }),
  ]
}

/** `scorecard`: the table plus what moved since the last run; saves a snapshot for the next diff. */
export async function runScorecard(io: Io, days: number, json: boolean, make: () => Promise<Runtime> = createRuntime): Promise<number> {
  const runtime = await make()
  try {
    await flushReports()
    const records = reportsFor(runtime.ctx).list()
    const current = scorecard(records, Date.now(), days)
    const previous = await loadSnapshot(runtime.ctx.config.home)
    const delta = scoreDelta(current, previous)
    const saved = await saveSnapshot(runtime.ctx.config.home, current)
    if (json) io.out(JSON.stringify({ scorecard: current, delta }))
    else for (const line of [...formatScorecardTable(current), ...formatDelta(delta)]) io.out(line)
    if (saved !== undefined) io.err(`opencode-delegate: snapshot not saved (${saved}) - next run shows no delta.`)
    return EXIT.ok
  } finally {
    await runtime.shutdown("scorecard done")
  }
}

function runWatch(args: string[]): Promise<number> {
  const script = path.join(import.meta.dir, "cli", "watch.ts")
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: "inherit", windowsHide: true })
    child.on("error", () => resolve(EXIT.failed))
    child.on("exit", (code) => resolve(code ?? EXIT.failed))
  })
}

export async function main(argv: string[], io: Io = processIo): Promise<number> {
  const command = parseCli(argv)
  switch (command.kind) {
    case "help":
      io.out(HELP)
      return EXIT.ok
    case "error":
      io.err(`opencode-delegate: ${command.message}`)
      return EXIT.usage
    case "version":
      io.out(formatVersion(await readVersion(), command.json))
      return EXIT.ok
    case "watch":
      return runWatch(command.args)
    case "doctor":
      return runDoctor(io)
    case "login":
      return runLogin(io)
    case "outcomes":
      return runOutcomes(io, command.days, command.redact)
    case "scorecard":
      return runScorecard(io, command.days, command.json)
    case "mcp":
      return runMcp(command.channels)
  }
}

if (import.meta.main) {
  let code: number
  try {
    code = await main(process.argv.slice(2))
  } catch (error) {
    const message = isDelegateError(error) ? `${error.code}: ${error.message} (${error.action})` : `unexpected error: ${error instanceof Error ? error.message : String(error)}`
    process.stderr.write(`opencode-delegate: ${scrub(message)}\n`)
    code = EXIT.failed
  }
  process.exit(code)
}
