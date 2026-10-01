// MOD-01 T1.3: thin wrapper over the docker CLI. Every call is an argument array run through
// spawn.ts (never a shell string). stdout of `docker inspect` can carry the server password,
// so callers must never log exec results; this module only returns parsed fields.
import net from "node:net"
import { DelegateError } from "../shared/errors.ts"
import { runProcess } from "./spawn.ts"

export type ExecResult = { code: number; stdout: string; stderr: string }
/** `cwd` matters for compose: without -f it would search the working folder and its parents. */
export type ExecOptions = { env?: Record<string, string>; timeoutMs?: number; cwd?: string }
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
  /** On `front`: sha256 of the generated servers file it was started with (review R4-01). */
  frontConfig: "com.alterspective.opencode-delegate.front-config",
  /** Baked into the image at build time (Dockerfile LABEL): `<version>-alterspective.<git sha>[.dirty.<hash>]`. */
  ociVersion: "org.opencontainers.image.version",
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

/** Exit code reported for a child killed by a signal it did not ask for. */
export const EXIT_SIGNALLED = 128

/**
 * Run argv. A missing binary is exit 127; a timeout kills the whole process tree (review N-4,
 * spawn.ts) and reports exit 124, returning within timeout + KILL_GRACE_MS even when a
 * grandchild keeps the output pipes open.
 */
export const bunExec: Exec = async (argv, options = {}) => {
  const result = await runProcess(argv, { env: options.env ?? childEnv(process.env), cwd: options.cwd, timeoutMs: options.timeoutMs })
  if (result.startError !== undefined) return { code: EXIT_NOT_FOUND, stdout: "", stderr: result.startError }
  if (result.timedOut) return { code: EXIT_TIMED_OUT, stdout: result.stdout, stderr: `${result.stderr}\n[timed out after ${options.timeoutMs} ms]`.trim() }
  return { code: result.code ?? EXIT_SIGNALLED, stdout: result.stdout, stderr: result.stderr }
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
  // `down` gets the same -f files as `up` (review N-1): without them Compose would look for a
  // compose file in the working folder and its parents and could load a stranger's. The caller
  // also runs it with cwd = config.home. --remove-orphans takes every container of the project,
  // even one a later compose.yaml no longer lists. Never -v: volumes hold the sign-in and sessions.
  down: (target: ComposeFiles) => compose(target, "down", "--remove-orphans"),
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
const CONTENT = /^[0-9a-f]{7,40}$/
const DIRTY = /^[0-9a-f]{8,16}$/

/**
 * Image tag = OpenCode version + content hash of the build inputs (identity.ts), plus
 * `-dirty-<hash>` for uncommitted builds (§4, VER-DEV-01).
 */
export function imageTag(image: string, version: string, content: string, dirty?: string): string {
  if (!VERSION.test(version) || !CONTENT.test(content) || (dirty !== undefined && !DIRTY.test(dirty)))
    throw new DelegateError(
      "sandbox_unavailable",
      "The OpenCode checkout has an unexpected version or commit, so the sandbox image cannot be named.",
      "Check packages/opencode/package.json and the git checkout, then retry.",
      `version=${version.slice(0, 40)} content=${content.slice(0, 40)}`,
    )
  const tag = `${version}-${content}${dirty ? `-dirty-${dirty}` : ""}`
  // 128 is Docker's tag limit; room is kept for the sibling suffixes (SIBLING_SERVICES).
  return `${image}:${tag.slice(0, 110)}`
}

const BUILT_FROM = /alterspective\.([0-9a-f]{7,40})(?:\.dirty\.([0-9a-f]{8,16}))?$/

/** The git sha an image was built from, read from its OCI version label: `<sha>` or `<sha>+dirty.<hash>`. */
export function builtFrom(labels: Record<string, string>): string | undefined {
  const match = BUILT_FROM.exec(labels[LABEL.ociVersion] ?? "")
  if (!match) return undefined
  return match[2] ? `${match[1]}+dirty.${match[2]}` : match[1]
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
