// Sandbox worker supervisor (FEAT-CAS-012 Phase 1, fork issue #47).
// Reads a task manifest, renders a managed OpenCode config, prepares /work/repo from a git
// bundle, and runs `opencode serve`. Phase 2 adds the outbound control link to the gateway.
import { $ } from "bun"
import path from "path"
import { PRIVACY_TIER, PRIVACY_TIER_ENV, renderConfig, type Manifest } from "./config"
import { checkBundleFile, checkDependenciesDir, checkTree } from "./bundle"
import { checkUnreachable } from "./egress-guard"
import { parseResolveBody } from "./policy"

const fail = (message: string): never => {
  console.error(`[sbxw] ${message}`)
  process.exit(2)
}

const manifest: Manifest = JSON.parse(process.env.SBXW_MANIFEST ?? fail("SBXW_MANIFEST is not set"))
if (!manifest.taskId) fail("manifest.taskId is required")
if (!manifest.model?.baseURL) fail("manifest.model.baseURL is required")
// Never run the server unauthenticated, even bound to loopback.
const password = process.env.SBXW_SERVER_PASSWORD ?? fail("SBXW_SERVER_PASSWORD is not set")

// #118: refuse to run if the cloud metadata endpoint is reachable (egress not locked down).
const metadata = await checkUnreachable()
if (!metadata.ok) fail(`refusing to start: ${metadata.detail} (run egress/lockdown.ts as root first)`)

// #108: the fork commit this image was built from (Dockerfile `GIT_SHA` build argument).
const buildSha = process.env.SBXW_BUILD_SHA || "unknown"
const configDir = process.env.OPENCODE_CONFIG_DIR ?? "/run/sbxw/config"
const repoDir = "/work/repo"

// #102: svc-coding-agent resolved and froze this for the task; the box makes no policy call and
// holds no CAS credential. Missing or unusable means `auto`, local-only.
const policy = parseResolveBody(manifest.modelPolicy, manifest.model.onPremDefault)
console.log(
  policy.source === "cas"
    ? `[sbxw] model policy: CAS version ${policy.effectivePolicyVersion}, models ${policy.modelIds.join(", ")}`
    : `[sbxw] model policy: fallback (${policy.reason}), models ${policy.modelIds.join(", ")}, ${PRIVACY_TIER}`,
)
const config = renderConfig(manifest, policy.modelIds)

const globalConfigDir = path.join(process.env.XDG_CONFIG_HOME ?? "/run/sbxw/xdg-config", "opencode")
await $`mkdir -p ${path.join(configDir, "plugins")} ${globalConfigDir}`
await Bun.write(path.join(configDir, "opencode.json"), JSON.stringify(config, null, 2))
// OpenCode writes a .gitignore into each config dir unless one exists (#41 spike finding).
for (const dir of [configDir, globalConfigDir]) await Bun.write(path.join(dir, ".gitignore"), "node_modules\npackage.json\nbun.lock\n")
await Bun.write(path.join(configDir, "plugins", "env-scrub.ts"), Bun.file("/opt/sbxw/plugins/env-scrub.ts"))
// #127: the box has no npm registry (egress lockdown, #118). At boot OpenCode installs
// @opencode-ai/plugin into every WRITABLE config dir and waits for it before loading plugins, so it
// hung behind the lockdown. A read-only dir is skipped (packages/core/src/npm.ts), and env-scrub.ts
// imports nothing. So the config dirs are read-only from here on.
await $`chmod 555 ${configDir} ${path.join(configDir, "plugins")} ${globalConfigDir}`

// Work inside the box on its own clone; never a bind mount of the host's repository.
// #108: a bundle that does not match what the service sent is refused before anything is served.
const verified = { sha256: false, tree: false }
if (manifest.repo?.bundle) {
  // Present at all means checked: an empty value fails the check rather than skipping it.
  if (manifest.repo.sha256 !== undefined) {
    const check = await checkBundleFile(manifest.repo.bundle, manifest.repo.sha256)
    if (!check.ok) fail(`refusing to start: ${check.reason}`)
    verified.sha256 = true
  }
  await $`git clone --quiet ${manifest.repo.bundle} ${repoDir}`
  if (manifest.repo.ref) await $`git -C ${repoDir} checkout --quiet ${manifest.repo.ref}`
  if (manifest.repo.treeSha !== undefined) {
    const check = await checkTree(repoDir, manifest.repo.treeSha)
    if (!check.ok) fail(`refusing to start: ${check.reason}`)
    verified.tree = true
  }
  // #85: dependencies the service installed before the egress lockdown. Moved with the system mv
  // (a rename on the same filesystem; Bun's builtin mv refuses a cross-device move), and kept out of
  // the patch below. A clone that already carries node_modules is refused: two sources of truth.
  if (manifest.repo.dependencies !== undefined) {
    const check = await checkDependenciesDir(manifest.repo.dependencies)
    if (!check.ok) fail(`refusing to start: ${check.reason}`)
    const target = path.join(repoDir, "node_modules")
    if ((await $`test -e ${target}`.nothrow().quiet()).exitCode === 0) {
      fail("refusing to start: the repository already has node_modules; repo.dependencies would shadow it")
    }
    const moved = await $`/bin/mv ${manifest.repo.dependencies} ${target}`.nothrow().quiet()
    if (moved.exitCode !== 0) fail(`refusing to start: cannot move repo.dependencies into the clone: ${moved.stderr.toString().trim()}`)
  }
} else {
  // Hashes with no bundle is an inconsistent manifest: refuse it rather than serve an empty repo.
  if (manifest.repo?.sha256 !== undefined || manifest.repo?.treeSha !== undefined) {
    fail("refusing to start: repo.sha256 or repo.treeSha was given without repo.bundle")
  }
  await $`mkdir -p ${repoDir}`
  await $`git -C ${repoDir} init --quiet`
}
// The fork's observer plugin writes session retrospectives into the workspace
// (packages/opencode/src/plugin/observer.ts). Keep them out of the patch without patching the fork.
const exclude = path.join(repoDir, ".git", "info", "exclude")
await Bun.write(exclude, `${await Bun.file(exclude).text().catch(() => "")}\n.system_generated/\nnode_modules/\n`)
await $`git -C ${repoDir} config user.name "OpenCode sandbox worker"`
await $`git -C ${repoDir} config user.email "sandbox-worker@noreply.alterspective.com.au"`
const baseSha = (await $`git -C ${repoDir} rev-parse --verify --quiet HEAD`.nothrow().text()).trim()

await Bun.write(
  "/run/sbxw/state.json",
  JSON.stringify({
    taskId: manifest.taskId,
    buildSha,
    repoDir,
    bundleVerified: verified,
    baseSha: baseSha || null,
    startedAt: new Date().toISOString(),
    // #102: which policy this task ran under (ADR-042: effectivePolicyVersion frozen at task start).
    modelPolicy: policy,
    privacyTier: PRIVACY_TIER,
    // #121: recorded only; the harness never reads this file (the agent can write it).
    harnessRequired: manifest.harness?.required === true,
  }),
)

const hostname = manifest.listen?.hostname ?? "127.0.0.1"
const port = manifest.listen?.port ?? 4096
const { SBXW_SERVER_PASSWORD: _drop, SBXW_MANIFEST: _manifest, ...env } = process.env
console.log(
  `[sbxw] task ${manifest.taskId}: build ${buildSha}, base ${baseSha || "(empty repo)"}, ` +
    `bundle sha256 ${verified.sha256 ? "verified" : "not checked"}, tree ${verified.tree ? "verified" : "not checked"}, ` +
    `serving on ${hostname}:${port}`,
)

// The Synapse plugin reads its base URL from SYNAPSE_BASE_URL and its key from stored auth;
// OPENCODE_AUTH_CONTENT supplies that auth without writing a file. Spike only: Phase 2 points
// SYNAPSE_BASE_URL at the gateway and the sandbox holds no key.
const auth = process.env.SBXW_MODEL_KEY ? { synapse: { type: "api", key: process.env.SBXW_MODEL_KEY } } : {}
const child = Bun.spawn(["opencode", "serve", "--hostname", hostname, "--port", String(port)], {
  cwd: repoDir,
  env: {
    ...env,
    OPENCODE_SERVER_PASSWORD: password,
    SYNAPSE_BASE_URL: manifest.model.baseURL,
    // #101: the Synapse plugin adds the tier to every Synapse call, not only the chat route.
    [PRIVACY_TIER_ENV]: PRIVACY_TIER,
    OPENCODE_AUTH_CONTENT: JSON.stringify(auth),
  },
  stdio: ["ignore", "inherit", "inherit"],
})
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal))
process.exit(await child.exited)
