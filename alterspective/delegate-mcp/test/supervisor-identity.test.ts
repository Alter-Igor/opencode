import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { defaultConfig } from "../src/shared/config.ts"
import { DelegateError } from "../src/shared/errors.ts"
import { bunExec, type Exec } from "../src/supervisor/docker.ts"
import { buildContextPathspecs, dockerignorePath } from "../src/supervisor/identity.ts"
import { defaultSupervisorDeps } from "../src/supervisor/lifecycle.ts"

const REAL_DOCKERIGNORE = path.resolve(import.meta.dir, "..", "docker", "box", "Dockerfile.dockerignore")

let repo: string
beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), "ocd-id-"))
})
afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

async function git(...args: string[]) {
  const result = await bunExec(["git", "-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args])
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
  return result.stdout.trim()
}

async function seed(version: unknown = "1.2.3") {
  await mkdir(path.join(repo, "packages", "opencode"), { recursive: true })
  await mkdir(path.dirname(dockerignorePath(repo)), { recursive: true })
  await writeFile(path.join(repo, "packages", "opencode", "package.json"), JSON.stringify({ name: "opencode", version }))
  await writeFile(dockerignorePath(repo), await readFile(REAL_DOCKERIGNORE, "utf8"))
  await writeFile(path.join(repo, "README.md"), "docs\n")
  await git("init", "-q")
  await git("add", "-A")
  await git("commit", "-q", "-m", "seed")
  return git("rev-parse", "--short=7", "HEAD")
}

const config = defaultConfig({ OPENCODE_DELEGATE_HOME: path.join(os.tmpdir(), "ocd-id-home") })
const options = () => ({ bridgeId: "b1", permission: [], repoRoot: repo })

describe("defaultSupervisorDeps: image identity (A-06)", () => {
  test("clean checkout → <version>-<sha>", async () => {
    const sha = await seed()
    const deps = await defaultSupervisorDeps(config, options())
    expect(deps.image).toBe(`opencode-delegate-box:1.2.3-${sha}`)
    expect(deps.opencodeVersion).toBe(`1.2.3-alterspective.${sha}`)
    expect(deps.composeFile).toBe(path.join(repo, "alterspective", "delegate-mcp", "docker", "compose.yaml"))
  })

  test("a change inside the build context → -dirty-<hash> that follows the content", async () => {
    const sha = await seed()
    await writeFile(path.join(repo, "packages", "opencode", "new.ts"), "export const a = 1\n")
    const first = (await defaultSupervisorDeps(config, options())).image
    expect(first).toMatch(new RegExp(`^opencode-delegate-box:1\\.2\\.3-${sha}-dirty-[0-9a-f]{12}$`))
    await writeFile(path.join(repo, "packages", "opencode", "new.ts"), "export const a = 2\n")
    const second = (await defaultSupervisorDeps(config, options())).image
    expect(second).not.toBe(first)
    expect((await defaultSupervisorDeps(config, options())).opencodeVersion).toContain(".dirty.")
  })

  test("a change outside the build context keeps the clean tag", async () => {
    const sha = await seed()
    await writeFile(path.join(repo, "README.md"), "changed docs\n")
    expect((await defaultSupervisorDeps(config, options())).image).toBe(`opencode-delegate-box:1.2.3-${sha}`)
  })

  test("missing or invalid version → sandbox_unavailable", async () => {
    await seed(null)
    const missing = await defaultSupervisorDeps(config, options()).catch((e: unknown) => e)
    expect((missing as DelegateError).code).toBe("sandbox_unavailable")
    await writeFile(path.join(repo, "packages", "opencode", "package.json"), JSON.stringify({ version: "1.0; rm" }))
    expect(((await defaultSupervisorDeps(config, options()).catch((e: unknown) => e)) as DelegateError).code).toBe("sandbox_unavailable")
  })

  test("git failure → sandbox_unavailable (never a thrown plain Error)", async () => {
    await seed()
    const broken: Exec = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" })
    const error = await defaultSupervisorDeps(config, { ...options(), exec: broken }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DelegateError)
    expect((error as DelegateError).code).toBe("sandbox_unavailable")
    expect((error as DelegateError).detail).toContain("not a git repository")
  })

  test("pathspecs come from the dockerignore allowlist", () => {
    const specs = buildContextPathspecs("*\n!package.json\n!packages\n# c\n**/node_modules\n")
    expect(specs).toEqual(["package.json", "packages", ":(exclude,glob)**/node_modules", ":(exclude,glob)**/node_modules/**"])
  })
})
