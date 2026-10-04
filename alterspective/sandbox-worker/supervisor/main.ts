// Sandbox worker supervisor (FEAT-CAS-012 Phase 1, fork issue #47).
// Reads a task manifest, renders a managed OpenCode config, prepares /work/repo from a git
// bundle, and runs `opencode serve`. Phase 2 adds the outbound control link to the gateway.
import { $ } from "bun"
import path from "path"
import { PRIVACY_TIER, PRIVACY_TIER_ENV, renderConfig, type Manifest } from "./config"

const fail = (message: string): never => {
  console.error(`[sbxw] ${message}`)
  process.exit(2)
}

const manifest: Manifest = JSON.parse(process.env.SBXW_MANIFEST ?? fail("SBXW_MANIFEST is not set"))
if (!manifest.taskId) fail("manifest.taskId is required")
if (!manifest.model?.baseURL || !manifest.model?.id) fail("manifest.model.baseURL and manifest.model.id are required")
// Never run the server unauthenticated, even bound to loopback.
const password = process.env.SBXW_SERVER_PASSWORD ?? fail("SBXW_SERVER_PASSWORD is not set")

const configDir = process.env.OPENCODE_CONFIG_DIR ?? "/run/sbxw/config"
const repoDir = "/work/repo"

const config = renderConfig(manifest)

await $`mkdir -p ${path.join(configDir, "plugins")} ${process.env.XDG_CONFIG_HOME ?? "/run/sbxw/xdg-config"}`
await Bun.write(path.join(configDir, "opencode.json"), JSON.stringify(config, null, 2))
// OpenCode writes a .gitignore into each config dir unless one exists (#41 spike finding).
await Bun.write(path.join(configDir, ".gitignore"), "node_modules\npackage.json\nbun.lock\n")
await Bun.write(path.join(configDir, "plugins", "env-scrub.ts"), Bun.file("/opt/sbxw/plugins/env-scrub.ts"))

// Work inside the box on its own clone; never a bind mount of the host's repository.
if (manifest.repo?.bundle) {
  await $`git clone --quiet ${manifest.repo.bundle} ${repoDir}`
  if (manifest.repo.ref) await $`git -C ${repoDir} checkout --quiet ${manifest.repo.ref}`
} else {
  await $`mkdir -p ${repoDir}`
  await $`git -C ${repoDir} init --quiet`
}
// The fork's observer plugin writes session retrospectives into the workspace
// (packages/opencode/src/plugin/observer.ts). Keep them out of the patch without patching the fork.
const exclude = path.join(repoDir, ".git", "info", "exclude")
await Bun.write(exclude, `${await Bun.file(exclude).text().catch(() => "")}\n.system_generated/\n`)
await $`git -C ${repoDir} config user.name "OpenCode sandbox worker"`
await $`git -C ${repoDir} config user.email "sandbox-worker@noreply.alterspective.com.au"`
const baseSha = (await $`git -C ${repoDir} rev-parse --verify --quiet HEAD`.nothrow().text()).trim()

await Bun.write(
  "/run/sbxw/state.json",
  JSON.stringify({ taskId: manifest.taskId, repoDir, baseSha: baseSha || null, startedAt: new Date().toISOString() }),
)

const hostname = manifest.listen?.hostname ?? "127.0.0.1"
const port = manifest.listen?.port ?? 4096
const { SBXW_SERVER_PASSWORD: _drop, SBXW_MANIFEST: _manifest, ...env } = process.env
console.log(`[sbxw] task ${manifest.taskId}: base ${baseSha || "(empty repo)"}, serving on ${hostname}:${port}`)

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
