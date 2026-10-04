// Spike driver (FEAT-CAS-012 Phase 1, fork issue #47). Stands in for CAS: starts one sandbox
// worker container, runs one coding task through the SDK, answers permission and question
// requests by rule, and collects the patch, tokens and cost as JSON.
//
//   SBXW_MODEL_KEY=<named spike key> bun alterspective/sandbox-worker/driver/run-task.ts \
//     --repo C:\path\to\repo --task "Add a test for foo" [--base-url https://…/v1] \
//     [--model-policy resolved.json] [--on-prem-default qwen3.8-27b-dflash2] [--timeout-min 30] [--keep]
//
// The models come from the CAS AI-roles policy (#102), not from a flag. In production
// svc-coding-agent resolves it (CAS #1674) and puts the answer in the manifest; here
// --model-policy passes a saved resolve answer (`{ cell, effectivePolicyVersion }`). Without it the
// supervisor fails closed to Synapse `auto` with x-privacy-tier: local-only.
//
// The model key is passed to the container in this spike only. Phase 2 replaces it with the
// gateway, and the sandbox then holds no key (ADR-037 decision 1).
import { parseArgs } from "util"
import path from "path"
import { chmod, rm } from "fs/promises"
import { randomBytes } from "crypto"
import { createOpencodeClient } from "../../../packages/sdk/js/src/v2/client"
import { sha256File } from "../supervisor/bundle"

const { values: args } = parseArgs({
  options: {
    repo: { type: "string" },
    task: { type: "string" },
    "model-policy": { type: "string" },
    "on-prem-default": { type: "string" },
    "base-url": { type: "string", default: "https://synapse2-api.alterspective.com.au/v1" },
    image: { type: "string", default: "opencodealt-sandbox-worker:spike" },
    "timeout-min": { type: "string", default: "30" },
    keep: { type: "boolean", default: false },
  },
})
if (!args.repo || !args.task) throw new Error("--repo and --task are required")
if (!process.env.SBXW_MODEL_KEY) throw new Error("SBXW_MODEL_KEY is not set")

const taskId = `sbxw-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`
const runDir = path.join(import.meta.dir, "..", "runs", taskId)
const bundle = path.join(runDir, "repo.bundle")
const password = randomBytes(24).toString("hex")
// 47200-47299: clear of the #41 spike's 127.0.0.1:47096.
const port = 47200 + Math.floor(Math.random() * 100)
const log = (message: string) => console.error(`[driver ${taskId}] ${message}`)
const run = async (cmd: string[], env?: Record<string, string>) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} exited ${code}: ${err.trim()}`)
  return out
}

await Bun.write(path.join(runDir, ".keep"), "")
await run(["git", "-C", args.repo, "bundle", "create", bundle, "HEAD"])
// The container runs as uid 10001 and mounts runDir read-only; a restrictive host umask must not
// stop it reading the bundle. (No effect on Windows hosts.)
await chmod(runDir, 0o755)
await chmod(bundle, 0o644)
const baseSha = (await run(["git", "-C", args.repo, "rev-parse", "HEAD"])).trim()
// #108: the box refuses to start unless the bundle and its tree match these.
const bundleSha256 = await sha256File(bundle)
const treeSha = (await run(["git", "-C", args.repo, "rev-parse", "HEAD^{tree}"])).trim()
log(`bundled ${args.repo} at ${baseSha} (tree ${treeSha}, bundle sha256 ${bundleSha256})`)

const manifest = {
  taskId,
  model: {
    baseURL: args["base-url"],
    headers: { "x-task-type": "code" },
    ...(args["on-prem-default"] ? { onPremDefault: args["on-prem-default"].split(",").map((id) => id.trim()) } : {}),
  },
  ...(args["model-policy"] ? { modelPolicy: await Bun.file(args["model-policy"]).json() } : {}),
  repo: { bundle: "/run/sbxw/input/repo.bundle", sha256: bundleSha256, treeSha },
  // Spike only: the server listens on all container interfaces so the host can reach it through
  // a loopback-only published port. Phase 2 keeps it on 127.0.0.1 and uses the outbound link.
  listen: { hostname: "0.0.0.0", port: 4096 },
}

// Secrets go to docker through its environment (`-e NAME` with no value), never on the command line.
await run(
  [
    "docker", "run", "-d", "--name", taskId,
    "-p", `127.0.0.1:${port}:4096`,
    "-v", `${runDir}:/run/sbxw/input:ro`,
    "-e", "SBXW_MANIFEST", "-e", "SBXW_SERVER_PASSWORD", "-e", "SBXW_MODEL_KEY",
    "--memory", "4g", "--cpus", "2", "--pids-limit", "1024",
    "--label", "alterspective.sandbox-worker=spike",
    args.image,
  ],
  { SBXW_MANIFEST: JSON.stringify(manifest), SBXW_SERVER_PASSWORD: password },
)
log(`container started on 127.0.0.1:${port}`)

// From here on the container holds the model key, so any failure must still remove it.
let exitCode = 0
try {
  exitCode = await drive()
} catch (err) {
  log(`failed: ${err instanceof Error ? err.message : String(err)}`)
  exitCode = 1
} finally {
  if (!args.keep) await run(["docker", "rm", "-f", taskId]).catch((e) => log(`cleanup failed: ${String(e)}`))
}
// The event stream stays open while the container lives (--keep), which would keep this process
// alive after the result is written.
process.exit(exitCode)

async function drive() {
  const baseUrl = `http://127.0.0.1:${port}`
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const started = Date.now()
  const deadline = started + Number(args["timeout-min"]) * 60_000

  let lastHealth = "no response"
  const healthy = async () => {
    while (Date.now() < started + 90_000) {
      const res = await fetch(`${baseUrl}/global/health`, { headers: { authorization }, signal: AbortSignal.timeout(5000) })
        .then((r) => r)
        .catch((e: Error) => {
          lastHealth = `fetch error: ${e.message}`
          return undefined
        })
      if (res) lastHealth = `HTTP ${res.status}`
      if (res?.ok) return true
      await Bun.sleep(1000)
    }
    return false
  }
  if (!(await healthy())) {
    log(`server did not become healthy within 90s (last: ${lastHealth})`)
    console.error(await run(["docker", "logs", taskId]).catch((e) => String(e)))
    return 1
  }

  const client = createOpencodeClient({ baseUrl, directory: "/work/repo", headers: { authorization } })
  const session = (await client.session.create({ title: `sandbox worker ${taskId}` }, { throwOnError: true })).data
  log(`session ${session.id}`)

  // Self-check, no model needed: run a shell command through the session and confirm the env-scrub
  // plugin loaded and blanked the control secrets for commands the agent runs.
  const probe = await client.session.shell(
    {
      sessionID: session.id,
      agent: "build",
      command:
        'test -z "$OPENCODE_SERVER_PASSWORD" && test -z "$SBXW_MODEL_KEY" && test -z "$OPENCODE_AUTH_CONTENT" && echo SCRUB_OK || echo SCRUB_FAIL',
    },
    { throwOnError: true },
  )
  const probeOutput = probe.data.parts
    .map((part) => (part.type === "tool" && part.state.status === "completed" ? part.state.output : ""))
    .join("")
  const envScrub = probeOutput.includes("SCRUB_OK") ? "ok" : probeOutput.includes("SCRUB_FAIL") ? "fail" : "unknown"
  log(`env scrub: ${envScrub}`)

  const decisions: { at: string; kind: string; permission?: string; patterns?: string[]; reply: string }[] = []
  const errors: string[] = []
  const events = await client.event.subscribe()
  // The SSE request only starts when iteration begins. The server registers its listener when the
  // request arrives and then sends `server.connected`, so the prompt waits for that event; otherwise
  // the terminal `session.status` could be published before anyone is listening.
  let onConnected = () => {}
  const connected = new Promise<void>((resolve) => (onConnected = resolve))
  const finished = (async () => {
    for await (const event of events.stream) {
      if (event.type === "server.connected") onConnected()
      if (event.type === "permission.asked" && event.properties.sessionID === session.id) {
        // Everything in-box is already `allow`; anything that still asks is refused. Never `always`.
        await client.permission.reply({ requestID: event.properties.id, reply: "reject" }, { throwOnError: true })
        decisions.push({
          at: new Date().toISOString(),
          kind: "permission",
          permission: event.properties.permission,
          patterns: event.properties.patterns,
          reply: "reject",
        })
      }
      if (event.type === "question.asked" && event.properties.sessionID === session.id) {
        // No human in the spike loop. CAS will turn this into an approval card in Phase 3.
        await client.question.reject({ requestID: event.properties.id }, { throwOnError: true })
        decisions.push({ at: new Date().toISOString(), kind: "question", reply: "reject" })
      }
      if (event.type === "session.error" && event.properties.sessionID === session.id) {
        errors.push(JSON.stringify(event.properties.error))
      }
      if (
        event.type === "session.status" &&
        event.properties.sessionID === session.id &&
        event.properties.status.type === "idle"
      )
        return "idle" as const
    }
    return "stream-ended" as const
  })().catch((e) => {
    // Observed before the race, so a late failure is recorded instead of becoming an unhandled rejection.
    errors.push(`event loop: ${e instanceof Error ? e.message : String(e)}`)
    return "event-loop-failed" as const
  })

  const ready = await Promise.race([connected.then(() => true), Bun.sleep(15_000).then(() => false)])
  if (!ready) throw new Error("event stream did not connect within 15s")
  await client.session.promptAsync(
    { sessionID: session.id, parts: [{ type: "text", text: args.task }] },
    { throwOnError: true },
  )
  log("task sent")

  const outcome = await Promise.race([finished, Bun.sleep(Math.max(0, deadline - Date.now())).then(() => "timeout" as const)])
  if (outcome === "timeout") {
    const aborted = await client.session.abort({ sessionID: session.id })
    if (aborted.error) errors.push(`abort failed: ${JSON.stringify(aborted.error)}`)
  }
  log(`outcome: ${outcome}`)

  // Tokens and cost as OpenCode reports them. Phase 2 replaces these with the gateway's ledger.
  const messages = (await client.session.messages({ sessionID: session.id }, { throwOnError: true })).data
  const usage = messages
    .map((m) => m.info)
    .filter((info) => info.role === "assistant")
    .reduce(
      (sum, info) => ({
        turns: sum.turns + 1,
        cost: sum.cost + (info.cost ?? 0),
        input: sum.input + (info.tokens?.input ?? 0),
        output: sum.output + (info.tokens?.output ?? 0),
        reasoning: sum.reasoning + (info.tokens?.reasoning ?? 0),
        cacheRead: sum.cacheRead + (info.tokens?.cache?.read ?? 0),
      }),
      { turns: 0, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0 },
    )

  // The patch is computed on the host, not in the box. The agent controlled /work/repo/.git (config,
  // hooks, diff drivers), so that directory is discarded: the box's files are copied out and compared
  // against a fresh clone of the bundle the driver itself created.
  const after = path.join(runDir, "after")
  const gitDir = path.join(runDir, "base.git")
  await run(["docker", "cp", `${taskId}:/work/repo`, after])
  await rm(path.join(after, ".git"), { recursive: true, force: true })
  // Host global and system git config stay out too: the agent controls `.gitattributes` in the copied
  // tree, and could otherwise invoke any filter the host config defines (for example `filter=lfs`).
  const emptyConfig = path.join(runDir, "empty.gitconfig")
  await Bun.write(emptyConfig, "")
  const isolated = { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" }
  await run(["git", "clone", "--quiet", "--bare", bundle, gitDir], isolated)
  await Bun.write(path.join(gitDir, "info", "exclude"), ".git\n.system_generated/\n")
  const git = (...rest: string[]) =>
    run(["git", "-c", "core.autocrlf=false", `--git-dir=${gitDir}`, `--work-tree=${after}`, ...rest], isolated)
  await git("reset", "--quiet")
  await git("add", "--all")
  const patch = await git("diff", "--cached", "--no-ext-diff", "--no-textconv", baseSha)
  const stat = await git("diff", "--cached", "--no-ext-diff", "--stat", baseSha)
  await Bun.write(path.join(runDir, "change.patch"), patch)

  const result = {
    taskId,
    sessionID: session.id,
    outcome,
    baseSha,
    wallSeconds: Math.round((Date.now() - started) / 1000),
    usage,
    patchBytes: Buffer.byteLength(patch),
    diffStat: stat.trim(),
    envScrub,
    decisions,
    errors,
    // #102: the policy the supervisor actually applied (models, version or fallback reason).
    modelPolicy: await run(["docker", "exec", taskId, "cat", "/run/sbxw/state.json"])
      .then((text) => JSON.parse(text).modelPolicy ?? null)
      .catch((error: unknown) => ({ unreadable: String(error) })),
  }
  await Bun.write(path.join(runDir, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  return 0
}
