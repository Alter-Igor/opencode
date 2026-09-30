import { describe, expect, test } from "bun:test"
import { DelegateError } from "../src/shared/errors.ts"
import { childEnv, dockerArgs, freePort, imageTag, inspectBox, parseInspect, requireDocker, type Exec } from "../src/supervisor/docker.ts"

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
    const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "No such container" })
    expect(await inspectBox(exec, [])).toBeUndefined()
    expect(parseInspect("not json", [])).toBeUndefined()
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
  test("tag = version-sha and rejects odd input", () => {
    expect(imageTag("opencode-delegate-box", "1.18.31", "1483a47")).toBe("opencode-delegate-box:1.18.31-1483a47")
    expect(() => imageTag("opencode-delegate-box", "1.0 ; x", "1483a47")).toThrow()
    expect(() => imageTag("opencode-delegate-box", "1.0", "zzz")).toThrow()
  })

  test("freePort returns a usable port", async () => {
    const port = await freePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
  })
})
