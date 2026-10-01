import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { defaultConfig } from "../src/shared/config.ts"
import { DelegateError } from "../src/shared/errors.ts"
import { bunExec, type Exec } from "../src/supervisor/docker.ts"
import { buildContextPathspecs, dockerignorePath, globToRegExp } from "../src/supervisor/identity.ts"
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

const image = async () => (await defaultSupervisorDeps(config, options())).image

async function commitFile(file: string, text: string, message: string) {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true })
  await writeFile(path.join(repo, file), text)
  await git("add", "-A")
  await git("commit", "-q", "-m", message)
}

describe("defaultSupervisorDeps: image identity (A-06, GAP-2 content hash)", () => {
  test("clean checkout → <version>-<12 hex content hash>; the sha is kept for information", async () => {
    const sha = await seed()
    const deps = await defaultSupervisorDeps(config, options())
    expect(deps.image).toMatch(/^opencode-delegate-box:1\.2\.3-[0-9a-f]{12}$/)
    expect(deps.image).not.toContain(sha)
    expect(deps.buildSha).toBe(sha)
    expect(deps.opencodeVersion).toBe(`1.2.3-alterspective.${sha}`)
    expect(deps.composeFile).toBe(path.join(repo, "alterspective", "delegate-mcp", "docker", "compose.yaml"))
  })

  test("two commits that only touch docs (and the bridge's own src) → the same tag", async () => {
    const first = await seed()
    const clean = await image()
    await commitFile("README.md", "changed docs\n", "docs 1")
    await commitFile("alterspective/delegate-mcp/src/bridge.ts", "export {}\n", "bridge code")
    await commitFile("alterspective/delegate-mcp/README.md", "more docs\n", "docs 2")
    const deps = await defaultSupervisorDeps(config, options())
    expect(deps.image).toBe(clean)
    expect(deps.buildSha).not.toBe(first)
  })

  test("a committed change under docker/ or packages/ → a new clean tag", async () => {
    await seed()
    const clean = await image()
    await commitFile("alterspective/delegate-mcp/docker/egress/allow.txt", "example.com\n", "egress")
    const egress = await image()
    expect(egress).toMatch(/^opencode-delegate-box:1\.2\.3-[0-9a-f]{12}$/)
    expect(egress).not.toBe(clean)
    await commitFile("packages/opencode/src/a.ts", "export const a = 1\n", "fork source")
    expect(await image()).not.toBe(egress)
  })

  test("tracked files the dockerignore excludes (dist, node_modules) do not change the tag", async () => {
    await seed()
    const clean = await image()
    await commitFile("packages/opencode/dist/out.js", "built\n", "dist")
    await commitFile("packages/app/node_modules/x/index.js", "dep\n", "vendored")
    expect(await image()).toBe(clean)
  })

  test("a change inside the build context → -dirty-<hash> that follows the content", async () => {
    await seed()
    const clean = await image()
    await writeFile(path.join(repo, "packages", "opencode", "new.ts"), "export const a = 1\n")
    const first = (await defaultSupervisorDeps(config, options())).image
    expect(first).toMatch(/^opencode-delegate-box:1\.2\.3-[0-9a-f]{12}-dirty-[0-9a-f]{12}$/)
    expect(first.startsWith(`${clean}-dirty-`)).toBe(true)
    await writeFile(path.join(repo, "packages", "opencode", "new.ts"), "export const a = 2\n")
    const second = (await defaultSupervisorDeps(config, options())).image
    expect(second).not.toBe(first)
    expect((await defaultSupervisorDeps(config, options())).opencodeVersion).toContain(".dirty.")
  })

  test("a change anywhere under docker/ (egress, caches, compose.yaml) → a new dirty tag (N-9)", async () => {
    const docker = path.join(repo, "alterspective", "delegate-mcp", "docker")
    await mkdir(path.join(docker, "egress"), { recursive: true })
    await writeFile(path.join(docker, "egress", "Dockerfile"), "FROM alpine\n")
    await writeFile(path.join(docker, "compose.yaml"), "services: {}\n")
    await seed()
    expect(await image()).toMatch(/^opencode-delegate-box:1\.2\.3-[0-9a-f]{12}$/)
    await writeFile(path.join(docker, "egress", "Dockerfile"), "FROM alpine:3.22\n")
    const egress = (await defaultSupervisorDeps(config, options())).image
    expect(egress).toMatch(/-dirty-[0-9a-f]{12}$/)
    await git("checkout", "--", ".")
    await writeFile(path.join(docker, "compose.yaml"), "services: { x: {} }\n")
    const compose = (await defaultSupervisorDeps(config, options())).image
    expect(compose).toMatch(/-dirty-[0-9a-f]{12}$/)
    expect(compose).not.toBe(egress)
    await git("checkout", "--", ".")
    await mkdir(path.join(docker, "caches", "npm"), { recursive: true })
    await writeFile(path.join(docker, "caches", "npm", "config.yaml"), "new: file\n")
    expect((await defaultSupervisorDeps(config, options())).image).toMatch(/-dirty-[0-9a-f]{12}$/)
  })

  test("a change outside the build context keeps the clean tag", async () => {
    await seed()
    const clean = await image()
    await writeFile(path.join(repo, "README.md"), "changed docs\n")
    expect(await image()).toBe(clean)
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

  test("dockerignore patterns match a path and everything below it", () => {
    const deep = globToRegExp("**/dist")
    expect(deep.test("dist")).toBe(true)
    expect(deep.test("packages/opencode/dist/bin/x")).toBe(true)
    expect(deep.test("packages/distance.ts")).toBe(false)
    const exact = globToRegExp("packages/opencode/opencode-web-ui.gen.ts")
    expect(exact.test("packages/opencode/opencode-web-ui.gen.ts")).toBe(true)
    expect(exact.test("packages/opencode/opencode-web-uiXgen.ts")).toBe(false)
    expect(globToRegExp("*.log").test("a/b.log")).toBe(false)
  })
})
