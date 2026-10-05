// #121: run the hidden acceptance tests. ROOT runs this through the E2B SDK after the agent
// claims GOAL_MET:
//   bun /opt/sbxw/supervisor/harness-run.ts /var/lib/sbxw-harness/in/request.json
// Prints the result JSON and writes it to /var/lib/sbxw-harness/result-<taskId>.json.
// Exit: 0 = tests passed, 1 = tests failed, 2 = harness error (fails closed: passed is false).
import { $ } from "bun"
import { lstat } from "fs/promises"
import path from "path"
import { sha256File } from "./bundle"
import {
  HARNESS_USER,
  classify,
  freezeSucceeded,
  exitCodeFor,
  harnessEnv,
  parseHarnessRequest,
  readTail,
  pathsToCheck,
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
  // The agent wrote the repo. A symlink where the tests go (say `hidden -> /tmp/x`) would make root
  // unpack the hidden tests outside the private copy, where the agent can read them later. The copy
  // sits in a root-only folder, so nothing can change it between this check and the unpack.
  const listed = await $`tar -tf ${request.archive}`.nothrow().quiet()
  if (listed.exitCode !== 0) throw new Error(`cannot list the tests archive: ${listed.stderr.toString().trim()}`)
  const checked = pathsToCheck(request.extractTo, listed.stdout.toString().split("\n"))
  if (!checked.ok) throw new Error(checked.reason)
  for (const rel of checked.paths) {
    const info = await lstat(path.join(work, rel)).catch(() => undefined)
    if (info?.isSymbolicLink()) throw new Error(`the repo has a symlink at ${rel}, where the hidden tests go`)
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
    // runuser alone dies; its children (bun test, a server the tests started) would keep the output
    // pipes open and hang this run. Kill everything the harness user owns.
    // main() checked that pkill exists; a spawn error here must not crash the runner.
    try {
      Bun.spawn(["pkill", "-KILL", "-u", HARNESS_USER], { stdout: "ignore", stderr: "ignore" })
    } catch {}
  }, request.timeoutSec * 1000)
  // Keep only the end of each stream while reading, so endless test output cannot exhaust memory.
  const [stdoutTail, stderrTail, exitCode] = await Promise.all([readTail(proc.stdout), readTail(proc.stderr), proc.exited])
  clearTimeout(timer)
  // A timeout is never a pass; classify() reports it as a harness error.
  return {
    ran: true,
    passed: !timedOut && exitCode === 0,
    exitCode: timedOut ? null : exitCode,
    timedOut,
    durationMs: Date.now() - started,
    stdoutTail,
    stderrTail,
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
    // pkill freezes the agent and kills the test tree on timeout, whatever freezeAgent says. Bun's
    // shell reports a missing command as exit 1 ("no process matched" for pkill), so check it exists.
    if (!Bun.which("pkill")) throw new Error("pkill is not installed (procps): cannot freeze the agent or stop the tests")
    const work = await prepare(request, workRoot)
    if (request.freezeAgent) {
      // Freeze the agent's processes so nothing it left running can race the tests. A freeze that
      // fails is a harness error, never a silent skip.
      const freeze = await $`pkill -STOP -u ${AGENT_USER}`.nothrow().quiet()
      frozen = true
      if (!freezeSucceeded(freeze.exitCode)) throw new Error(`cannot freeze the agent's processes (pkill exit ${freeze.exitCode})`)
    }
    outcome = await runTests(request, work, workRoot)
  } catch (error) {
    outcome = { ran: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    // Nothing the tests started may outlive the run (and the agent must not find it later).
    await $`pkill -KILL -u ${HARNESS_USER}`.nothrow().quiet()
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
