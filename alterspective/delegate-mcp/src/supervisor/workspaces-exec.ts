// MOD-01 workspaces: process execution and host path canonicalisation (split from workspaces.ts).
// Every command is an argument array (no shell strings) and has a deadline (review A-14).
import { execFile } from "node:child_process"
import { realpathSync } from "node:fs"
import path from "node:path"
import { DelegateError } from "../shared/errors.ts"

export type ExecResult = { code: number; stdout: string; stderr: string; timedOut?: boolean }
export type ExecOptions = { timeoutMs?: number }
export type Exec = (argv: readonly string[], options?: ExecOptions) => Promise<ExecResult>

/** Exit code reported when a command was killed at its deadline (as coreutils `timeout`). */
export const TIMEOUT_CODE = 124

/** Environment for child processes: never inherit GIT_* (GIT_DIR, GIT_CONFIG_PARAMETERS, ...). */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (!/^GIT_/i.test(key)) out[key] = value
  return out
}

/**
 * Run one command. `timeoutMs` kills it at the deadline and reports TIMEOUT_CODE / timedOut.
 * On Windows the kill reaches the direct child only (for `docker exec` that is the CLI, not the
 * process inside the box).
 */
export function runCommand(argv: readonly string[], env: NodeJS.ProcessEnv = cleanEnv(), timeoutMs?: number): Promise<ExecResult> {
  const [file, ...args] = argv
  if (!file) return Promise.resolve({ code: 127, stdout: "", stderr: "empty command" })
  return new Promise((resolve) => {
    const options = { env, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs ?? 0, killSignal: "SIGKILL" as const }
    execFile(file, args, options, (error, stdout, stderr) => {
      const timedOut = Boolean(timeoutMs && error?.killed && String(error.code) !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      if (timedOut) return resolve({ code: TIMEOUT_CODE, stdout: String(stdout), stderr: `timed out after ${timeoutMs} ms`, timedOut })
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : "")) })
    })
  })
}

/** Parse `subst` output lines such as `T:\: => X:\some\dir`. */
export function parseSubst(output: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Za-z]):\\: => (.+)$/.exec(line.trim())
    if (match?.[1] && match[2]) map[match[1].toUpperCase() + ":"] = match[2].trim()
  }
  return map
}

export async function systemSubst(): Promise<Record<string, string>> {
  if (process.platform !== "win32") return {}
  const result = await runCommand(["subst"], cleanEnv(), 10_000)
  return result.code === 0 ? parseSubst(result.stdout) : {}
}

/** directory_invalid with an action that names the configured roots (review A-22). */
export function invalidFolder(roots: readonly string[], message: string, detail?: string): DelegateError {
  const where = roots.length > 0 ? roots.join("; ") : "(none configured: set OPENCODE_DELEGATE_ROOTS)"
  return new DelegateError("directory_invalid", message, `Pass a git repository folder under an allowed root: ${where}.`, detail)
}

function applySubst(p: string, subst: Record<string, string>): string {
  let current = p
  for (let hop = 0; hop < 4; hop++) {
    const drive = current.slice(0, 2).toUpperCase()
    const target = /^[A-Z]:$/.test(drive) ? subst[drive] : undefined
    if (!target) return current
    current = path.win32.join(target, current.slice(2))
  }
  return current
}

/** Canonical, real path of an existing directory (subst and junctions resolved). */
export function canonicalPath(input: string, subst: Record<string, string>, roots: readonly string[] = []): string {
  if (input.split(/[\\/]+/).includes("..")) throw invalidFolder(roots, "The folder path may not contain '..'.", input)
  const win = process.platform === "win32"
  const resolved = win ? applySubst(path.win32.resolve(input), subst) : path.resolve(input)
  let real: string
  try {
    real = realpathSync.native(resolved)
  } catch {
    throw invalidFolder(roots, "The folder does not exist.", resolved)
  }
  return win ? applySubst(real, subst) : real
}

export function isUnder(candidate: string, root: string): boolean {
  const win = process.platform === "win32"
  const norm = (p: string) => (win ? p.replace(/\//g, "\\").toLowerCase() : p)
  const c = norm(candidate)
  const r = norm(root)
  const sep = win ? "\\" : "/"
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep)
}

export const samePath = (a: string, b: string) => isUnder(a, b) && isUnder(b, a)
