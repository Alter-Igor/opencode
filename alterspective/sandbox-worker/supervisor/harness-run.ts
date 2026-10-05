// #121: run the hidden acceptance tests. ROOT runs this through the E2B SDK after the agent
// claims GOAL_MET:
//   bun /opt/sbxw/supervisor/harness-run.ts /var/lib/sbxw-harness/in/request.json
// Prints the result JSON and writes it to /var/lib/sbxw-harness/result-<taskId>.json.
// Exit: 0 = tests passed, 1 = tests failed, 2 = harness error (fails closed: passed is false).
import { $ } from "bun"
import path from "path"
import { sha256File } from "./bundle"
import {
  HARNESS_USER,
  classify,
  exitCodeFor,
  harnessEnv,
  parseHarnessRequest,
  tail,
  type HarnessOutcome,
  type HarnessRequest,
} from "./harness"

const ROOT = "/var/lib/sbxw-harness"
const AGENT_USER = process.env.SBXW_AGENT_USER || "agent"

async function prepare(request: HarnessRequest, workRoot: string): Promise<string> {
  if ((await sha256File(request.archive).catch(() => "")) !== request.sha256) throw new Error("tests archive SHA-256 mismatch")
  if ((await $`id -u ${HARNESS_USER}`.nothrow().quiet()).exitCode !== 0) {
    const made = await $`useradd -m -s /bin/sh ${HARNESS_USER}`.nothrow().quiet()
    if (made.exitCode !== 0) throw new Error(`cannot create ${HARNESS_USER}: ${made.stderr.toString().trim()}`)
  }
  // The root folder is traversable but not listable (0711): the harness user must be able to reach
  // its own run folder (bun resolves the absolute cwd; 0700 here made `bun test` find no files).
  // Each run folder is private to the harness user, and the service's in/ folder stays 0700 root.
  await $`mkdir -p ${ROOT}`.quiet()
  await $`chmod 711 ${ROOT}`.quiet()
  await $`mkdir -p ${workRoot}`.quiet()
  await $`chmod 700 ${workRoot}`.quiet()
  const work = path.join(workRoot, "work")
  const copied = await $`cp -a ${request.repoDir}/. ${work}/`.nothrow().quiet()
  if ((await $`test -d ${work}`.nothrow().quiet()).exitCode !== 0 || copied.exitCode !== 0) {
    throw new Error(`cannot copy ${request.repoDir}: ${copied.stderr.toString().trim()}`)
  }
  const target = path.join(work, request.extractTo)
  await $`mkdir -p ${target}`.quiet()
  const unpacked = await $`tar -xf ${request.archive} -C ${target} --no-same-owner`.nothrow().quiet()
  if (unpacked.exitCode !== 0) throw new Error(`cannot unpack the tests: ${unpacked.stderr.toString().trim()}`)
  await $`chown -R ${HARNESS_USER}:${HARNESS_USER} ${workRoot}`.quiet()
  return work
}

async function runTests(request: HarnessRequest, work: string, home: string): Promise<HarnessOutcome> {
  const started = Date.now()
  const proc = Bun.spawn(["runuser", "-u", HARNESS_USER, "--", ...request.command], {
    cwd: work,
    env: harnessEnv(home),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill("SIGKILL")
  }, request.timeoutSec * 1000)
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  // A timeout is a failed run, never a pass.
  return {
    ran: true,
    passed: !timedOut && exitCode === 0,
    exitCode: timedOut ? null : exitCode,
    timedOut,
    durationMs: Date.now() - started,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  }
}

async function main(): Promise<number> {
  if (process.getuid?.() !== 0) {
    console.error("[sbxw-harness] must run as root")
    return 2
  }
  const raw = await Bun.file(process.argv[2] ?? "").json().catch(() => undefined)
  const parsed = parseHarnessRequest(raw)
  const taskId = parsed.ok ? parsed.request.taskId : "unknown"
  const agentClaim = parsed.ok ? parsed.request.agentClaim : "UNKNOWN"
  let outcome: HarnessOutcome
  const workRoot = path.join(ROOT, `run-${taskId}-${Date.now()}`)
  let frozen = false
  try {
    if (!parsed.ok) throw new Error(`bad request: ${parsed.reason}`)
    const request = parsed.request
    const work = await prepare(request, workRoot)
    if (request.freezeAgent) {
      // Freeze the agent's processes so nothing it left running can race the tests.
      await $`pkill -STOP -u ${AGENT_USER}`.nothrow().quiet()
      frozen = true
    }
    outcome = await runTests(request, work, workRoot)
  } catch (error) {
    outcome = { ran: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (frozen) await $`pkill -CONT -u ${AGENT_USER}`.nothrow().quiet()
    await $`rm -rf ${workRoot}`.nothrow().quiet()
  }
  const agreement = classify(agentClaim, outcome)
  const result = { taskId, agentClaim, harness: outcome, agreement, finishedAt: new Date().toISOString() }
  await $`mkdir -p ${ROOT}`.nothrow().quiet()
  const resultFile = path.join(ROOT, `result-${taskId}.json`)
  await Bun.write(resultFile, JSON.stringify(result, null, 2) + "\n")
  // Root-only: the output names the hidden tests, and a continuing agent session must not learn them.
  await $`chmod 600 ${resultFile}`.nothrow().quiet()
  console.log(JSON.stringify(result))
  return exitCodeFor(agreement, outcome)
}

process.exit(await main())
