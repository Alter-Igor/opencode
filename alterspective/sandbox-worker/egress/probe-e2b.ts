// #118 (svc-coding-agent#46): prove the in-sandbox egress lockdown in a REAL E2B sandbox.
//
//   E2B_API_KEY=… bun alterspective/sandbox-worker/egress/probe-e2b.ts --out <file.json>
//     [--allow-host 1.1.1.1] [--allow-port 443] [--template <id>]
//
// One sandbox, default E2B network (open), so the blocking seen is this firewall's, not E2B's:
//   1. create a non-sudo user and run the checks as it (BEFORE);
//   2. apply renderRuleset() as root with `nft -f`;
//   3. run the same checks as that user (AFTER), read the drop counters, try to change the rules
//      and sudo as that user, and run one more SDK command.
// Never prints the API key. Writes the evidence JSON and prints the go/no-go line.
import { parseArgs } from "util"
import path from "path"
import { CommandExitError, Sandbox } from "e2b"
import { TABLE, parseCounters, renderRuleset } from "./rules"
import { decide, probePlan, type CheckResult } from "./verdict"

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    "allow-host": { type: "string", default: "1.1.1.1" },
    "allow-port": { type: "string", default: "443" },
    template: { type: "string" },
  },
})
if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY is not set")
if (!args.out) throw new Error("--out <file.json> is required")

const AGENT = "sbxwagent"
const allow = { host: args["allow-host"]!, port: Number(args["allow-port"]) }
const ruleset = renderRuleset({ allow: [{ cidr: allow.host, port: allow.port }] })
const plan = probePlan(allow)

type Shell = { exitCode: number; stdout: string; stderr: string }
/** Run a command in the sandbox as `user`; a non-zero exit is a result, not an exception. */
async function sh(sbx: Sandbox, cmd: string, user: string): Promise<Shell> {
  try {
    const r = await sbx.commands.run(cmd, { user, timeoutMs: 120_000 })
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  } catch (error) {
    if (error instanceof CommandExitError) return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr }
    throw error
  }
}

/** Run checks.py as the non-sudo agent user and parse its JSON results. */
const runChecks = async (sbx: Sandbox): Promise<CheckResult[]> => {
  const r = await sh(sbx, "python3 /tmp/sbxw-checks.py /tmp/sbxw-plan.json", AGENT)
  if (r.exitCode !== 0) throw new Error(`checks failed: ${r.stderr.trim()}`)
  return JSON.parse(r.stdout)
}

const started = new Date().toISOString()
const sbx = await Sandbox.create({ ...(args.template ? { template: args.template } : {}), timeoutMs: 10 * 60_000 })
try {
  const env = (await sh(sbx, "uname -r; . /etc/os-release; echo $PRETTY_NAME; nft --version", "root")).stdout.trim()
  const created = await sh(sbx, `id ${AGENT} >/dev/null 2>&1 || useradd -m ${AGENT}`, "root")
  if (created.exitCode !== 0) throw new Error(`useradd failed: ${created.stderr.trim()}`)
  await sbx.files.write("/tmp/sbxw-checks.py", await Bun.file(path.join(import.meta.dir, "checks.py")).text())
  await sbx.files.write("/tmp/sbxw-plan.json", JSON.stringify(plan))
  await sh(sbx, "chmod 644 /tmp/sbxw-checks.py /tmp/sbxw-plan.json", "root")

  const before = await runChecks(sbx)

  await sbx.files.write("/tmp/sbxw-egress.nft", ruleset)
  const applied = await sh(sbx, "nft -f /tmp/sbxw-egress.nft", "root")
  if (applied.exitCode !== 0) throw new Error(`nft -f failed: ${applied.stderr.trim()}`)

  const after = await runChecks(sbx)
  const listing = (await sh(sbx, `nft list table ip ${TABLE}; nft list table ip6 ${TABLE}`, "root")).stdout
  // Full path: /usr/sbin is not on the agent's PATH, and "command not found" would prove nothing.
  const flush = await sh(sbx, "/usr/sbin/nft flush ruleset", AGENT)
  const sudo = await sh(sbx, "sudo -n true", AGENT)
  const stillLocked = (await sh(sbx, `nft list table ip ${TABLE} && nft list table ip6 ${TABLE}`, "root")).exitCode === 0
  const sdk = await sh(sbx, "echo sdk-ok", "root")

  const observations = {
    before,
    after,
    counters: parseCounters(listing),
    agentFlushExit: flush.exitCode === 0 && !stillLocked ? 0 : flush.exitCode || 1,
    agentSudoExit: sudo.exitCode,
    sdkWorksAfter: sdk.exitCode === 0 && sdk.stdout.includes("sdk-ok"),
  }
  const verdict = decide(observations)
  const report = {
    probe: "svc-coding-agent#46 T1 follow-up: in-sandbox egress lockdown (fork #118)",
    started,
    finished: new Date().toISOString(),
    sandbox: { template: args.template ?? "e2b default", environment: env },
    allow,
    ruleset,
    observations: { ...observations, agentFlushStderr: flush.stderr.trim().slice(0, 300), agentSudoStderr: sudo.stderr.trim().slice(0, 300) },
    counterListing: listing,
    verdict,
  }
  await Bun.write(args.out, JSON.stringify(report, null, 2) + "\n")
  console.log(verdict.line)
  for (const f of verdict.failures) console.log(`  FAIL ${f}`)
  for (const n of verdict.notes) console.log(`  note ${n}`)
  process.exitCode = verdict.go ? 0 : 1
} finally {
  await sbx.kill()
}
