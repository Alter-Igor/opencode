// MOD-01 T1.3: thin wrapper over the docker CLI. Every call is an argument array run with
// Bun.spawn (never a shell string). stdout of `docker inspect` can carry the server password,
// so callers must never log exec results; this module only returns parsed fields.
import net from "node:net"
import { DelegateError } from "../shared/errors.ts"

export type ExecResult = { code: number; stdout: string; stderr: string }
export type ExecOptions = { env?: Record<string, string>; timeoutMs?: number }
export type Exec = (argv: string[], options?: ExecOptions) => Promise<ExecResult>

/** Exit codes bunExec reports when it could not run the command at all (as shells do). */
export const EXIT_NOT_FOUND = 127
export const EXIT_TIMED_OUT = 124

/** Default project name; the box container is named after the project (compose.yaml). */
export const BOX_CONTAINER = "opencode-delegate"
export const LABEL = {
  profileHash: "com.alterspective.opencode-delegate.profile-hash",
  port: "com.alterspective.opencode-delegate.port",
  image: "com.alterspective.opencode-delegate.image",
} as const

/** Host variables the docker CLI itself needs. Everything else is withheld from the compose child. */
const HOST_ENV = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP", "HOME",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles",
  "ProgramFiles(x86)", "ProgramW6432", "USERNAME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG",
  "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "DOCKER_BUILDKIT", "BUILDKIT_PROGRESS", "XDG_RUNTIME_DIR",
]

/** Minimal env for a docker child: CLI essentials from the host + exactly the given extras. */
export function childEnv(host: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of HOST_ENV) {
    const value = host[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, ...extra }
}

/** Run argv. A missing binary is exit 127; a timeout kills the child and reports exit 124. */
export const bunExec: Exec = async (argv, options = {}) => {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(argv, { env: options.env ?? childEnv(process.env), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    return { code: EXIT_NOT_FOUND, stdout: "", stderr: String(error) }
  }
  let timedOut = false
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true
        proc.kill()
      }, options.timeoutMs)
    : undefined
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ])
  if (timer) clearTimeout(timer)
  if (timedOut) return { code: EXIT_TIMED_OUT, stdout, stderr: `${stderr}\n[timed out after ${options.timeoutMs} ms]`.trim() }
  return { code, stdout, stderr }
}

export type ComposeFiles = { project: string; files: string[] }

function compose(target: ComposeFiles, ...rest: string[]): string[] {
  return ["docker", "compose", "-p", target.project, ...target.files.flatMap((file) => ["-f", file]), ...rest]
}

export const dockerArgs = {
  serverVersion: () => ["docker", "version", "--format", "{{.Server.Version}}"],
  imageExists: (tag: string) => ["docker", "image", "inspect", "--format", "{{.Id}}", tag],
  inspect: (name: string) => [
    "docker", "inspect", "--type", "container", "--format",
    '{"state":{{json .State}},"labels":{{json .Config.Labels}},"env":{{json .Config.Env}},"image":{{json .Config.Image}}}',
    name,
  ],
  up: (target: ComposeFiles, build: boolean) => compose(target, "up", "-d", "--remove-orphans", ...(build ? ["--build"] : [])),
  // `down` without -f: Compose finds the project by label, so no interpolation vars are needed. Never -v.
  down: (project: string) => ["docker", "compose", "-p", project, "down"],
}

/** Docker CLI missing or daemon not running → sandbox_unavailable. There is no fallback (edge case 11). */
export async function requireDocker(exec: Exec): Promise<string> {
  const result = await exec(dockerArgs.serverVersion(), { timeoutMs: 20_000 })
  const version = result.stdout.trim()
  if (result.code === 0 && version) return version
  throw new DelegateError(
    "sandbox_unavailable",
    "Docker is not available, so the sandbox cannot start.",
    "Start Docker Desktop and retry. The bridge never runs OpenCode outside the sandbox.",
    `exit ${result.code}: ${result.stderr.trim().slice(0, 300)}`,
  )
}

export type BoxInspect = {
  running: boolean
  health: "healthy" | "unhealthy" | "starting" | "none"
  labels: Record<string, string>
  image: string
  /** Only the variables asked for; the rest of the container env is discarded unread. */
  env: Record<string, string>
}

const NOT_FOUND = /No such (container|object)/i

/** undefined only when Docker says the container does not exist; any other failure is sandbox_unavailable. */
export async function inspectBox(exec: Exec, wanted: string[], name = BOX_CONTAINER): Promise<BoxInspect | undefined> {
  const result = await exec(dockerArgs.inspect(name), { timeoutMs: 20_000 })
  if (result.code !== 0 && NOT_FOUND.test(result.stderr)) return undefined
  const box = result.code === 0 ? parseInspect(result.stdout, wanted) : undefined
  if (box) return box
  throw new DelegateError(
    "sandbox_unavailable",
    "The bridge could not read the sandbox state from Docker.",
    "Check Docker Desktop is running, then run oc_doctor.",
    result.code === 0 ? "docker inspect returned unreadable output" : `docker inspect exit ${result.code}: ${result.stderr.trim().slice(0, 300)}`,
  )
}

type RawInspect = { state?: { Running?: boolean; Health?: { Status?: string } }; labels?: Record<string, string> | null; env?: string[] | null; image?: string }

export function parseInspect(stdout: string, wanted: string[]): BoxInspect | undefined {
  let raw: RawInspect
  try {
    raw = JSON.parse(stdout.trim()) as RawInspect
  } catch {
    return undefined
  }
  const env: Record<string, string> = {}
  for (const line of raw.env ?? []) {
    const eq = line.indexOf("=")
    const key = eq === -1 ? line : line.slice(0, eq)
    if (wanted.includes(key)) env[key] = line.slice(eq + 1)
  }
  const status = raw.state?.Health?.Status
  const health = status === "healthy" || status === "unhealthy" || status === "starting" ? status : "none"
  return { running: raw.state?.Running === true, health, labels: raw.labels ?? {}, image: raw.image ?? "", env }
}

export async function imageExists(exec: Exec, tag: string): Promise<boolean> {
  return (await exec(dockerArgs.imageExists(tag), { timeoutMs: 20_000 })).code === 0
}

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const SHA = /^[0-9a-f]{7,40}$/
const DIRTY = /^[0-9a-f]{8,16}$/

/** Image tag = OpenCode version + git short SHA, plus `-dirty-<hash>` for uncommitted builds (§4, VER-DEV-01). */
export function imageTag(image: string, version: string, sha: string, dirty?: string): string {
  if (!VERSION.test(version) || !SHA.test(sha) || (dirty !== undefined && !DIRTY.test(dirty)))
    throw new DelegateError(
      "sandbox_unavailable",
      "The OpenCode checkout has an unexpected version or commit, so the sandbox image cannot be named.",
      "Check packages/opencode/package.json and the git checkout, then retry.",
      `version=${version.slice(0, 40)} sha=${sha.slice(0, 40)}`,
    )
  const tag = `${version}-${sha}${dirty ? `-dirty-${dirty}` : ""}`
  return `${image}:${tag.slice(0, 128)}`
}

/** Remove every secret value from text (e.g. compose stderr that echoes the environment). */
export function redactAll(text: string, secrets: string[]): string {
  return secrets.filter((secret) => secret.length > 0).reduce((out, secret) => out.split(secret).join("[redacted]"), text)
}

/** A free 127.0.0.1 TCP port (the OS picks it). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))))
    })
  })
}
