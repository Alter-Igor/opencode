#!/usr/bin/env bun
// opencode-delegate CLI (bin). `mcp` (default) is the stdio MCP server: in that mode stdout carries
// MCP frames only, so console.log is sent to stderr and logs go to stderr + <home>/logs (D-1).
// Exit codes (CLI-UX-22): 0 ok, 1 error, 2 bad arguments; `watch` passes on its own codes.
import { spawn } from "node:child_process"
import path from "node:path"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { isDelegateError } from "./shared/errors.ts"
import { scrub } from "./shared/log.ts"
import { createRuntime, readVersion, shutdownSignal, type VersionInfo } from "./runtime.ts"
import { createServer } from "./server.ts"
import { doctorTool } from "./tools/doctor.ts"

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const

export const HELP = `opencode-delegate — delegate coding work to sandboxed OpenCode sessions over MCP

Usage:
  opencode-delegate [mcp] [--channels]   Run the stdio MCP server (what an AI client starts)
  opencode-delegate watch [options]      One line per session event that needs attention (see: watch --help)
  opencode-delegate doctor               Print the oc_doctor report as JSON (read-only; never starts the sandbox)
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
  return { kind: "error", message: `Unknown command: ${printable(command)}. Run with --help.` }
}

export type Io = { out(text: string): void; err(text: string): void }

const processIo: Io = { out: (text) => void process.stdout.write(text + "\n"), err: (text) => void process.stderr.write(text + "\n") }

export function formatVersion(info: VersionInfo, json: boolean): string {
  return json ? JSON.stringify(info) : `opencode-delegate ${info.version}`
}

async function runMcp(channels: boolean): Promise<number> {
  // Anything a dependency prints must not corrupt the MCP stream.
  console.log = console.error
  console.info = console.error
  const runtime = await createRuntime()
  const { server, close } = createServer(runtime.ctx, { channels })
  const stopped = shutdownSignal(process)
  await server.connect(new StdioServerTransport())
  runtime.ctx.log.log("info", "cli", "MCP server listening on stdio", { bridge: runtime.name, channels })
  const reason = await stopped
  await close().catch(() => undefined)
  await runtime.shutdown(reason)
  return EXIT.ok
}

async function runDoctor(io: Io): Promise<number> {
  const runtime = await createRuntime()
  try {
    const result = await doctorTool.run({}, runtime.ctx, runtime.ctx.correlationId())
    io.out(JSON.stringify(result.structuredContent ?? {}, null, 2))
    return result.isError ? EXIT.failed : EXIT.ok
  } finally {
    await runtime.shutdown("doctor done")
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
