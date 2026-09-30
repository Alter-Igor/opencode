// MOD-01 T1.3: thin wrapper over the docker CLI. Every call is an argument array run with
// Bun.spawn (never a shell string). stdout of `docker inspect` can carry the server password,
// so callers must never log exec results; this module only returns parsed fields.
import net from "node:net"
import { DelegateError } from "../shared/errors.ts"

export type ExecResult = { code: number; stdout: string; stderr: string }
export type ExecOptions = { env?: Record<string, string>; timeoutMs?: number }
export type Exec = (argv: string[], options?: ExecOptions) => Promise<ExecResult>

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

export const bunExec: Exec = async (argv, options = {}) => {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(argv, { env: options.env ?? childEnv(process.env), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    return { code: 127, stdout: "", stderr: String(error) }
  }
  const timer = options.timeoutMs ? setTimeout(() => proc.kill(), options.timeoutMs) : undefined
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ])
  if (timer) clearTimeout(timer)
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
    result.stderr.trim().slice(0, 300),
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

export async function inspectBox(exec: Exec, wanted: string[], name = BOX_CONTAINER): Promise<BoxInspect | undefined> {
  const result = await exec(dockerArgs.inspect(name), { timeoutMs: 20_000 })
  if (result.code !== 0) return undefined
  return parseInspect(result.stdout, wanted)
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

/** Image tag = OpenCode package version + git short SHA (technical-design.md §4, §8). */
export function imageTag(image: string, version: string, sha: string): string {
  if (!/^[0-9A-Za-z._-]+$/.test(version) || !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("invalid image version or sha")
  return `${image}:${version}-${sha}`
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
