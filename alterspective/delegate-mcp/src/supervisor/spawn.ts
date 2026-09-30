// MOD-01: the one place the bridge starts a child process (review N-4).
// Used by docker.ts (bunExec) and workspaces-exec.ts (runCommand). Every call is an argument
// array (no shell). On a deadline the WHOLE process tree is killed, not just the direct child:
//   Windows: `taskkill /T /F /PID <child pid>` (that exact PID and its descendants, nothing else);
//   POSIX:   the child runs in its own process group (detached) and the group gets SIGKILL.
// A grandchild can still hold the stdout/stderr pipes open after the child is gone (for example a
// process that broke away from the tree), so the call stops waiting for the pipes after a grace
// period and returns what it has. The same grace applies after a normal exit.
import { spawn, type ChildProcess } from "node:child_process"
import path from "node:path"

export const KILL_GRACE_MS = 2_000

export type ProcessOptions = {
  env: NodeJS.ProcessEnv | Record<string, string>
  cwd?: string
  timeoutMs?: number
  /** Stop and report an overflow when stdout + stderr exceed this many bytes. Default: no limit. */
  maxBuffer?: number
  /** How long to wait for the pipes to close after the child exited or was killed. */
  graceMs?: number
}

export type ProcessResult = {
  /** Exit code; undefined when the child never started or died by a signal. */
  code: number | undefined
  signal?: string
  stdout: string
  stderr: string
  timedOut: boolean
  overflow: boolean
  /** Set when the program could not be started at all (e.g. ENOENT). */
  startError?: string
}

const POSIX_GROUP = process.platform !== "win32"

function taskkillPath(): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")
}

/** Kill `child` and every process it started. Never throws; never touches any other PID. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === "win32") {
    try {
      // Tree first: killing the parent first would orphan its children and hide them from /T.
      const killer = spawn(taskkillPath(), ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true })
      killer.once("error", () => child.kill())
      killer.once("exit", () => child.kill())
    } catch {
      child.kill()
    }
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

export function runProcess(argv: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  const [file, ...args] = argv
  if (!file) return Promise.resolve({ code: undefined, stdout: "", stderr: "", timedOut: false, overflow: false, startError: "empty command" })
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(file, args, { env: options.env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: POSIX_GROUP })
    } catch (error) {
      return resolve({ code: undefined, stdout: "", stderr: "", timedOut: false, overflow: false, startError: String(error) })
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let bytes = 0
    let timedOut = false
    let overflow = false
    let done = false
    let code: number | undefined
    let signal: string | undefined
    let grace: ReturnType<typeof setTimeout> | undefined
    const graceMs = options.graceMs ?? KILL_GRACE_MS

    const finish = (startError?: string) => {
      if (done) return
      done = true
      if (deadline) clearTimeout(deadline)
      if (grace) clearTimeout(grace)
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut, overflow, startError })
    }
    const startGrace = () => {
      grace ??= setTimeout(() => finish(), graceMs)
    }
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      if (done) return
      bytes += chunk.length
      if (options.maxBuffer !== undefined && bytes > options.maxBuffer) {
        if (!overflow) {
          overflow = true
          killTree(child)
          startGrace()
        }
        return
      }
      into.push(chunk)
    }
    child.stdout?.on("data", collect(out))
    child.stderr?.on("data", collect(err))
    child.once("error", (error) => {
      // Spawn failure (ENOENT, EACCES): no exit event follows.
      if (child.pid === undefined) finish(error.message)
    })
    child.once("exit", (exitCode, exitSignal) => {
      code = exitCode ?? undefined
      signal = exitSignal ?? undefined
      startGrace() // a grandchild may still hold the pipes
    })
    child.once("close", (exitCode, exitSignal) => {
      code ??= exitCode ?? undefined
      signal ??= exitSignal ?? undefined
      finish()
    })
    const deadline = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          killTree(child)
          startGrace()
        }, options.timeoutMs)
      : undefined
  })
}
