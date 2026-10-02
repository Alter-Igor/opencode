#!/usr/bin/env bun
// opencode-delegate CLI (bin). `mcp` (default) is the stdio MCP server: in that mode stdout carries
// MCP frames only, so every console method that writes to stdout is sent to stderr (W3A-18) and
// logs go to stderr + <home>/logs (D-1).
// Exit codes (CLI-UX-22): 0 ok, 1 error, 2 bad arguments; `watch` passes on its own codes.
import { spawn } from "node:child_process"
import path from "node:path"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { isDelegateError } from "./shared/errors.ts"
import { scrub } from "./shared/log.ts"
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
  return { kind: "error", message: `Unknown command: ${printable(command)}. Run with --help.` }
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
