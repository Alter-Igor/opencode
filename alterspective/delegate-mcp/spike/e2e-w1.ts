// Wave 1 live end-to-end (dev helper): scratch repo -> workspace in the box -> real OpenCode
// session edits + commits -> branch fetched back to the host. Uses the real supervisor,
// workspaces and guard. Roots are pointed at a temp folder so nothing under C:\GitHub is touched.
import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { defaultConfig } from "../src/shared/config.ts"
import { createApi } from "../src/shared/opencode-api.ts"
import { createLogger } from "../src/shared/log.ts"
import { createGuard } from "../src/guard/index.ts"
import { createSupervisor, defaultSupervisorDeps } from "../src/supervisor/lifecycle.ts"
import { containerName } from "../src/supervisor/compose-env.ts"
import { createWorkspaces } from "../src/supervisor/workspaces.ts"

const scratchRoot = mkdtempSync(path.join(os.tmpdir(), "ocd-e2e-"))
const repo = path.join(scratchRoot, "demo")
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
execFileSync("git", ["init", "-q", "-b", "main", repo])
writeFileSync(path.join(repo, "README.md"), "# demo\n")
git("add", ".")
git("-c", "user.email=e2e@local", "-c", "user.name=e2e", "commit", "-qm", "init")

const config = { ...defaultConfig(), roots: [scratchRoot] }
const log = createLogger({ minLevel: "warn" })
const guard = createGuard(config)
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..")
const deps = await defaultSupervisorDeps(config, { bridgeId: `e2e-${process.pid}`, permission: guard.permissionBaseline("standard"), repoRoot, log })
const target = await createSupervisor(deps).ensure()
const api = createApi(target)
const workspaces = createWorkspaces({ config, container: containerName(config) })

const key = `e2e-${Date.now().toString(36)}`
const ws = await workspaces.open(repo, key)
console.error("workspace:", ws.boxPath, ws.branch)

const verdict = await guard.checkRuntime(api, ws.boxPath)
console.error("guard:", JSON.stringify(verdict))
if (!verdict.ok) process.exit(3)

const session = (await api.call<{ id: string }>({ method: "POST", path: "/session", directory: ws.boxPath, body: { title: "e2e w1", permission: guard.permissionBaseline("standard") } })).data!
await api.call({
  method: "POST",
  path: `/session/${session.id}/prompt_async`,
  directory: ws.boxPath,
  body: {
    model: { providerID: "synapse", modelID: "auto" },
    parts: [{ type: "text", text: "Create a file hello.txt containing exactly: hi from the box. Then run: git add hello.txt && git -c user.email=box@local -c user.name=box commit -m 'box: hello'. Reply DONE when finished." }],
  },
})
for (let i = 0; i < 90; i++) {
  await Bun.sleep(3000)
  const status = (await api.call<Record<string, unknown>>({ path: "/session/status", directory: ws.boxPath })).data ?? {}
  if (!(session.id in status)) break
}
const messages = (await api.call<Array<{ info: { role: string; error?: unknown }; parts: Array<{ type: string; tool?: string; state?: { status?: string }; text?: string }> }>>({ path: `/session/${session.id}/message`, directory: ws.boxPath })).data ?? []
for (const m of messages) {
  if (m.info.error) console.error("ERROR:", JSON.stringify(m.info.error).slice(0, 300))
  for (const p of m.parts) {
    if (p.type === "tool") console.error("tool:", p.tool, p.state?.status)
    if (p.type === "text" && m.info.role === "assistant" && p.text?.trim()) console.error("text:", p.text.trim().slice(0, 120))
  }
}

const result = await workspaces.collect(ws)
console.error("collect:", JSON.stringify(result))
console.error("host branch file:", git("show", `${result.branch}:hello.txt`))
console.error("host HEAD still:", git("rev-parse", "--abbrev-ref", "HEAD"))
