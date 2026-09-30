import { describe, expect, test } from "bun:test"
import { DelegateError } from "../src/shared/errors.ts"
import { EXIT_NOT_FOUND, EXIT_TIMED_OUT, bunExec, childEnv, dockerArgs, freePort, imageTag, inspectBox, parseInspect, redactAll, requireDocker, type Exec } from "../src/supervisor/docker.ts"

const target = { project: "opencode-delegate", files: ["C:\\repo\\docker\\compose.yaml", "C:\\home\\compose.box-env.yaml"] }

describe("docker args are argument arrays, never shell strings", () => {
  test("compose up passes project, every file and --build only when asked", () => {
    expect(dockerArgs.up(target, true)).toEqual([
      "docker", "compose", "-p", "opencode-delegate",
      "-f", "C:\\repo\\docker\\compose.yaml", "-f", "C:\\home\\compose.box-env.yaml",
      "up", "-d", "--remove-orphans", "--build",
    ])
    expect(dockerArgs.up(target, false)).not.toContain("--build")
  })

  test("down never removes volumes", () => {
    expect(dockerArgs.down("opencode-delegate")).toEqual(["docker", "compose", "-p", "opencode-delegate", "down"])
    expect(dockerArgs.down("opencode-delegate")).not.toContain("-v")
  })

  test("a path with spaces or shell metacharacters stays one argument", () => {
    const odd = { project: "opencode-delegate", files: ["C:\\Users\\A B\\x;rm -rf ~\\compose.yaml"] }
    const argv = dockerArgs.up(odd, false)
    expect(argv[5]).toBe("C:\\Users\\A B\\x;rm -rf ~\\compose.yaml")
    for (const builder of [dockerArgs.serverVersion(), dockerArgs.inspect("opencode-delegate"), dockerArgs.imageExists("a:b"), argv])
      expect(Array.isArray(builder) && builder.every((part) => typeof part === "string")).toBe(true)
  })
})

describe("child env", () => {
  test("keeps only CLI essentials plus explicit extras", () => {
    const env = childEnv({ PATH: "p", USERPROFILE: "u", OPENROUTER_API_KEY: "leak", GITHUB_TOKEN: "leak" }, { OCD_PORT: "1" })
    expect(env).toEqual({ PATH: "p", USERPROFILE: "u", OCD_PORT: "1" })
  })
})

describe("inspect parsing", () => {
  const raw = JSON.stringify({
    state: { Running: true, Health: { Status: "healthy" } },
    labels: { "com.alterspective.opencode-delegate.port": "4711" },
    env: ["PATH=/usr/bin", "OPENCODE_SERVER_PASSWORD=pw=with=equals", "SYNAPSE_API_KEY=should-not-be-read"],
    image: "opencode-delegate-box:1-abcdef0",
  })

  test("returns only the env vars asked for", () => {
    const box = parseInspect(raw, ["OPENCODE_SERVER_PASSWORD"])!
    expect(box.env).toEqual({ OPENCODE_SERVER_PASSWORD: "pw=with=equals" })
    expect(box.running).toBe(true)
    expect(box.health).toBe("healthy")
    expect(box.labels["com.alterspective.opencode-delegate.port"]).toBe("4711")
  })

  test("missing container → undefined", async () => {
    const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "Error: No such container: opencode-delegate" })
    expect(await inspectBox(exec, [])).toBeUndefined()
    const object: Exec = async () => ({ code: 1, stdout: "", stderr: "Error: No such object: opencode-delegate" })
    expect(await inspectBox(object, [])).toBeUndefined()
    expect(parseInspect("not json", [])).toBeUndefined()
  })

  test("any other inspect failure → sandbox_unavailable, never 'not running' (A-10)", async () => {
    for (const result of [
      { code: 1, stdout: "", stderr: "error during connect: pipe not found" },
      { code: 124, stdout: "", stderr: "[timed out]" },
      { code: 0, stdout: "garbage", stderr: "" },
    ]) {
      const error = await inspectBox(async () => result, []).catch((e: unknown) => e)
      expect((error as DelegateError).code).toBe("sandbox_unavailable")
    }
  })
})

describe("docker availability", () => {
  test("daemon down → sandbox_unavailable, never a fallback", async () => {
    const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "error during connect: pipe not found" })
    const error = await requireDocker(exec).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DelegateError)
    expect((error as DelegateError).code).toBe("sandbox_unavailable")
  })

  test("daemon up → server version", async () => {
    const exec: Exec = async () => ({ code: 0, stdout: "29.8.0\n", stderr: "" })
    expect(await requireDocker(exec)).toBe("29.8.0")
  })
})

describe("image tag + port", () => {
  test("tag = version-sha(-dirty-hash) and rejects odd input with a DelegateError (A-06)", () => {
    expect(imageTag("opencode-delegate-box", "1.18.31", "1483a47")).toBe("opencode-delegate-box:1.18.31-1483a47")
    expect(imageTag("opencode-delegate-box", "1.18.31", "1483a47", "0123456789ab")).toBe("opencode-delegate-box:1.18.31-1483a47-dirty-0123456789ab")
    for (const [version, sha, dirty] of [["1.0 ; x", "1483a47"], ["1.0", "1483a47"], ["1.0.0", "zzz"], ["1.0.0", ""], ["1.0.0", "1483a47", "NOTHEX!!"]] as const) {
      const error = (() => {
        try {
          return imageTag("opencode-delegate-box", version, sha, dirty)
        } catch (e) {
          return e
        }
      })()
      expect((error as DelegateError).code).toBe("sandbox_unavailable")
    }
  })

  test("redactAll removes every secret occurrence", () => {
    expect(redactAll("pw=abc; again abc; key=k1", ["abc", "k1", ""])).toBe("pw=[redacted]; again [redacted]; key=[redacted]")
  })

  test("freePort returns a usable port", async () => {
    const port = await freePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
  })
})

// Real child processes, using this Bun binary as the child (portable, no shell).
describe("bunExec", () => {
  const bun = process.execPath
  const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" }

  test("returns exit code, stdout and stderr", async () => {
    const result = await bunExec([bun, "-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"], { env })
    expect(result).toEqual({ code: 3, stdout: "out", stderr: "err" })
  })

  test("a missing binary is exit 127, not a throw", async () => {
    const result = await bunExec(["definitely-not-a-real-binary-ocd"], { env })
    expect(result.code).toBe(EXIT_NOT_FOUND)
  })

  test("a timeout kills the child and reports 124", async () => {
    const started = Date.now()
    const result = await bunExec([bun, "-e", "setTimeout(() => {}, 60000)"], { env, timeoutMs: 300 })
    expect(result.code).toBe(EXIT_TIMED_OUT)
    expect(result.stderr).toContain("timed out")
    expect(Date.now() - started).toBeLessThan(20_000)
  })

  test("the child gets only the env it is given", async () => {
    process.env.OCD_SECRET_PROBE = "leak"
    try {
      const result = await bunExec([bun, "-e", "process.stdout.write(String(process.env.OCD_SECRET_PROBE))"], { env })
      expect(result.stdout).toBe("undefined")
    } finally {
      delete process.env.OCD_SECRET_PROBE
    }
  })
})
