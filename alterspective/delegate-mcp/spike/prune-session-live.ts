// Own scratch repo, bridge home and compose project only. No prompt/model call or owner sign-in.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { createRuntime, REPO_ROOT } from "../src/runtime.ts"
import { defaultConfig } from "../src/shared/config.ts"
import { silentLogger } from "../src/shared/log.ts"
import { composeDownEnv } from "../src/supervisor/compose-env.ts"
import { defaultSupervisorDeps } from "../src/supervisor/deps.ts"
import { runCommand } from "../src/supervisor/workspaces-exec.ts"
import { startSessionTool, listSessionsTool } from "../src/tools/sessions.ts"
import { collectTool } from "../src/tools/collect.ts"

const scratch = mkdtempSync(path.join(os.tmpdir(), "ocd-prune-live-"))
const project = `ocd-prune-${randomBytes(4).toString("hex")}`
const repo = path.join(scratch, "repo")
mkdirSync(repo)
const config = { ...defaultConfig({}), home: path.join(scratch, "home"), roots: [scratch], project, keystoneConnections: [], keystoneAllowed: [] }
const env = { ...process.env, MSYS_NO_PATHCONV: "1", OPENCODE_DELEGATE_NAME: "prune-proof" }
async function command(argv: string[]) {
  const result = await runCommand(argv, env, 120_000)
  assert.equal(result.code, 0, `${argv[0]} failed (output withheld)`)
  return result.stdout.trim()
}
await command(["git", "-C", repo, "init", "-q", "-b", "main"])
writeFileSync(path.join(repo, "README.md"), "# Scratch pruning proof\n")
await command(["git", "-C", repo, "add", "README.md"])
await command(["git", "-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"])
const runtime = await createRuntime({ config, env, log: silentLogger })
const deps = await defaultSupervisorDeps(config, { bridgeId: "prune-cleanup", permission: runtime.ctx.guard.permissionBaseline("standard"), repoRoot: REPO_ROOT, log: silentLogger })
try {
  const box = await runtime.ctx.box()
  const start = await startSessionTool.run({ directory: repo }, runtime.ctx, "prune-start")
  const sessionID = String(start.structuredContent?.sessionID)
  const record = runtime.ctx.sessions.get(sessionID)
  assert.ok(record)
  assert.match(record.boxPath, /^\/sessions\/s-[0-9a-f]{10}$/)
  const file = path.join(config.home, "workspaces", `${record.sessionKey}.json`)
  assert.ok(existsSync(file))
  const deleted = await box.api.call({ method: "DELETE", path: `/session/${sessionID}`, directory: record.boxPath })
  assert.equal(deleted.status, 200)
  await listSessionsTool.run({}, runtime.ctx, "prune-kept")
  assert.ok(existsSync(file))
  const collected = await collectTool.run({ sessionID }, runtime.ctx, "prune-collect")
  assert.equal(collected.structuredContent?.commits, 0)
  const removed = await runtime.ctx.boxExec(["rm", "-rf", "--", record.boxPath])
  assert.equal(removed.code, 0)
  const direct = await box.api.call({ path: `/session/${sessionID}`, directory: record.boxPath })
  console.log(JSON.stringify({ missingDirectoryStatus: direct.status, cloneKeptBeforeRemoval: true, cachedCollectPassed: true }))
  assert.equal(direct.status, 404)
  await listSessionsTool.run({}, runtime.ctx, "prune-absent")
  assert.equal(existsSync(file), false)

  const second = await startSessionTool.run({ directory: repo, allowShared: true }, runtime.ctx, "prune-link-start")
  const linkedID = String(second.structuredContent?.sessionID)
  const linked = runtime.ctx.sessions.get(linkedID)
  assert.ok(linked)
  assert.match(linked.boxPath, /^\/sessions\/s-[0-9a-f]{10}$/)
  assert.equal((await box.api.call({ method: "DELETE", path: `/session/${linkedID}`, directory: linked.boxPath })).status, 200)
  assert.equal((await runtime.ctx.boxExec(["rm", "-rf", "--", linked.boxPath])).code, 0)
  assert.equal((await runtime.ctx.boxExec(["ln", "-s", "/sessions/prune-nonexistent-target", linked.boxPath])).code, 0)
  await listSessionsTool.run({}, runtime.ctx, "prune-dangling")
  assert.ok(existsSync(path.join(config.home, "workspaces", `${linked.sessionKey}.json`)))
  console.log(JSON.stringify({ hostRecordPruned: true, danglingCloneRecordKept: true, project }))
} finally {
  await runtime.shutdown("prune proof ended")
  const result = await runCommand(["docker", "compose", "-p", project, "-f", deps.composeFile, "down", "-v", "--remove-orphans"], composeDownEnv(deps), 120_000)
  assert.equal(result.code, 0, "owned compose project cleanup failed (output withheld)")
  assert.equal(await command(["docker", "ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]), "")
  console.log(JSON.stringify({ project, ownedContainersRemoved: true, scratch }))
}
