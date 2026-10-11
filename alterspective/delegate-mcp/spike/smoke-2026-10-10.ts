// Live smoke of the PR #153 features (owner ask 2026-10-10): drives `bun src/cli.ts mcp` over
// stdio exactly as Claude Code does, scratch repos under %TEMP% only (nothing under C:\GitHub is
// touched). Covers: doctor truth + leases, syncRef (OB-2), head+tail + paging (D3), taskRole
// fallback (D4 stage 1), oc_collect verify exit codes (D6), readonly permission + oc_answer with
// sessionID (D1), close. Prints PASS/FAIL per check; exit 1 if any FAIL.
import { execFileSync } from "node:child_process"
import { createWriteStream, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { createGuard } from "../src/guard/index.ts"
import { defaultConfig } from "../src/shared/config.ts"
import { createLogger } from "../src/shared/log.ts"
import { createSupervisor, defaultSupervisorDeps } from "../src/supervisor/lifecycle.ts"

// The saved box set carries `dynamic` (owner decision B): this spike's ceiling must match it.
process.env.OPENCODE_DELEGATE_KEYSTONE_ALLOWED = "rag-read,github,seqlogs,dynamic"
process.env.OCD_KEYSTONE_HOST_AUTH = "1"
process.env.OPENCODE_DELEGATE_DYNAMIC_PROFILE = '{"deniedToolPatterns":["*__delete_*"]}'

const scratchRoot = mkdtempSync(path.join(os.tmpdir(), "ocd-smoke1010-"))
const say = (line: string) => console.error(line)
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()

let failures = 0
const check = (name: string, cond: boolean, detail = "") => {
  say(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail.slice(0, 160)}]` : ""}`)
  if (!cond) failures++
}

function makeRepo(name: string): string {
  const repo = path.join(scratchRoot, name)
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  writeFileSync(path.join(repo, "README.md"), `# ${name}\n`)
  git(repo, "add", ".")
  git(repo, "-c", "user.email=smoke@local", "-c", "user.name=smoke", "commit", "-qm", "init")
  return repo
}

let boxTarget: { baseUrl: string; password: string } | undefined
async function holdLease(): Promise<void> {
  const config = defaultConfig()
  const guard = createGuard(config)
  const repoRoot = path.resolve(import.meta.dir, "..", "..", "..")
  const deps = await defaultSupervisorDeps(config, { bridgeId: `smoke-holder-${process.pid}`, permission: guard.permissionBaseline("standard"), repoRoot, log: createLogger({ minLevel: "warn" }) })
  boxTarget = await createSupervisor(deps).ensure()
}

let client: Client
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }>; isError?: boolean }> {
  const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 420_000 })) as { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }>; isError?: boolean }
  say(`> ${name} ${JSON.stringify(args).slice(0, 140)} => ${result.isError ? "ERROR " : ""}${result.content?.[0]?.text?.split("\n")[0]?.slice(0, 200) ?? ""}`)
  return result
}
const sc = (r: Awaited<ReturnType<typeof call>>) => r.structuredContent ?? {}

async function waitUntil(ids: string[], until: string[], cursor?: string, rounds = 8): Promise<Array<Record<string, unknown>>> {
  let next = cursor
  const events: Array<Record<string, unknown>> = []
  for (let round = 0; round < rounds; round++) {
    const r = await call("oc_wait", { sessionIDs: ids, until, timeoutSec: 240, ...(next ? { cursor: next } : {}) })
    next = String(sc(r).next ?? "") || undefined
    for (const e of (sc(r).events as Array<Record<string, unknown>>) ?? []) events.push(e)
    const views = (sc(r).views as Array<{ state?: string }>) ?? []
    const settled = [...events.map((e) => String(e.state ?? "")), ...views.map((v) => String(v.state ?? ""))]
    if (until.some((u) => settled.includes(u))) return events
  }
  return events
}

async function main(): Promise<void> {
  await holdLease()
  const cli = path.resolve(import.meta.dir, "..", "src", "cli.ts")
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env.OPENCODE_DELEGATE_ROOTS = scratchRoot
  env.OPENCODE_DELEGATE_NAME = "smoke-1010"
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, stderr: "pipe" })
  transport.stderr?.pipe(createWriteStream(path.join(scratchRoot, "bridge-stderr.log")))
  client = new Client({ name: "smoke1010", version: "0.0.1" })
  await client.connect(transport)

  // 1. doctor: truth + leases (Tier-1 #4)
  const doctor = await call("oc_doctor")
  const d = sc(doctor)
  check("doctor verified:true", d.verified === true, `verified=${d.verified}`)
  const box = (d.box ?? {}) as Record<string, unknown>
  check("doctor box running + imageMatches", box.state === "running" && box.imageMatches === true, JSON.stringify(box).slice(0, 200))
  const gate = (d.gate ?? {}) as Record<string, unknown>
  check("doctor gate reachable", gate.reachable === true, JSON.stringify(gate).slice(0, 120))
  const leases = d.leases as { count: number; leases: Array<{ bridgeId: string; alive: boolean }> } | undefined
  check("doctor lists leases (new)", leases !== undefined && leases.count >= 1 && leases.leases.some((l) => l.alive), JSON.stringify(leases ?? "").slice(0, 200))

  // 2. session A + syncRef (OB-2) proven end-to-end
  const repoA = makeRepo("v-a")
  const a = sc(await call("oc_start_session", { directory: repoA, title: "smoke a", model: "synapse/auto" }))
  const sidA = String(a.sessionID)
  writeFileSync(path.join(repoA, "marker.txt"), "MARKER-42\n")
  git(repoA, "add", "marker.txt")
  git(repoA, "-c", "user.email=smoke@local", "-c", "user.name=smoke", "commit", "-qm", "add marker")
  const sentSync = sc(await call("oc_send", { sessionID: sidA, message: "Read marker.txt with your tools. Then: git add -A && git commit -m 'smoke commit' && echo committed. Reply exactly: MARKER=<the file content>.", syncRef: "main" }))
  check("oc_send with syncRef accepted (OB-2 fixed)", sentSync.accepted === true, JSON.stringify(sentSync).slice(0, 160))
  await waitUntil([sidA], ["idle", "error"], String(sentSync.cursor))
  const resSync = (sc(await call("oc_result", { sessionID: sidA })).replies as Array<{ untrusted?: { text?: string } }>)?.[0]?.untrusted?.text ?? ""
  check("synced file readable in box session", resSync.includes("MARKER-42"), resSync.slice(0, 120))

  // 3. head+tail + paging (D3)
  const longTask = "Reply with exactly 250 lines, numbered 1..250, each line of the form 'line NNNN fillerfillerfillerfillerfillerfillerfillerfiller' (about 60 characters), and make the FINAL line exactly 'VERDICT: KEEP'. Use no tools. No other text."
  const sentLong = sc(await call("oc_send", { sessionID: sidA, message: longTask, model: "synapse/auto" }))
  await waitUntil([sidA], ["idle", "error"], String(sentLong.cursor))
  const longRes = sc(await call("oc_result", { sessionID: sidA }))
  const reply = (longRes.replies as Array<{ untrusted: { text: string; truncated: boolean }; textTotal: number; messageID?: string }>)[0]
  check("long reply exceeds the budget (else the task prompt was not honoured)", (reply?.textTotal ?? 0) > 12_000, `textTotal=${reply?.textTotal}`)
  if (reply && reply.textTotal > 12_000) {
    check("long reply truncated with marker", reply.untrusted.truncated === true && reply.untrusted.text.includes("omitted from the middle"))
    check("tail survives: VERDICT present (D3)", reply.untrusted.text.trimEnd().includes("VERDICT: KEEP"), `textTotal=${reply.textTotal}`)
    check("messageID present for paging", typeof reply.messageID === "string")
    const page = sc(await call("oc_result", { sessionID: sidA, messageID: reply.messageID, textOffset: Math.max(0, reply.textTotal - 60) }))
    const pageText = (page.untrusted as { text: string })?.text ?? ""
    check("paging returns the tail window", pageText.includes("VERDICT: KEEP") && page.textNext === undefined, JSON.stringify(page).slice(0, 140))
  }

  // 4. taskRole (D4): picks from Synapse's live suitability with serving history, or falls back
  // with a stated reason - either shape is fine, a missing taskPick or a silent failure is not.
  const sentRole = sc(await call("oc_send", { sessionID: sidA, message: "Reply PONG only.", taskRole: "code" }))
  const pick = sentRole.taskPick as { model?: string; fellBack?: string } | undefined
  check("taskRole send accepted with a taskPick (model or reason)", sentRole.accepted === true && pick !== undefined && (pick.model !== undefined || pick.fellBack !== undefined), JSON.stringify(pick ?? "").slice(0, 200))
  await waitUntil([sidA], ["idle", "error"], String(sentRole.cursor))

  // 5. oc_collect verify (D6): pass, then fail, then the branch still lands
  const v1 = sc(await call("oc_collect", { sessionID: sidA, verify: ["bun --version"] }))
  check("verify pass reports bridge-observed exit 0", (v1.verify as { passed: boolean })?.passed === true && (v1.verify as { rows: Array<{ exitCode: number }> }).rows[0]?.exitCode === 0)
  const v2r = await call("oc_collect", { sessionID: sidA, verify: ["bun -e process.exit(7)"] })
  const v2 = sc(v2r)
  check("verify fail marks claim unproven but still fetched", (v2.verify as { passed: boolean })?.passed === false && (v2.verify as { rows: Array<{ exitCode: number }> }).rows[0]?.exitCode === 7 && typeof v2.branch === "string", JSON.stringify(v2).slice(0, 200))
  const firstLine = ((v2r.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "").split("\n")[0] ?? ""
  check("failed verify summary says VERIFICATION FAILED and names unproven", firstLine.includes("VERIFICATION FAILED") && firstLine.includes("unproven"), firstLine.slice(0, 180))
  const branchFiles = git(repoA, "ls-tree", "--name-only", String(v2.branch))
  check("collected branch carries the synced marker commit", branchFiles.includes("marker.txt"), branchFiles.slice(0, 80))

  // 6. readonly session + permission + oc_answer {sessionID} (D1 live path)
  const repoB = makeRepo("v-b")
  const b = sc(await call("oc_start_session", { directory: repoB, title: "smoke b", profile: "readonly", model: "synapse/auto" }))
  const sidB = String(b.sessionID)
  const sentB = sc(await call("oc_send", { sessionID: sidB, message: "Run the command whoami. Reply with its output." }))
  const events = await waitUntil([sidB], ["needs_input", "idle", "error"], String(sentB.cursor), 6)
  const need = events.find((e) => e.requestID !== undefined)
  const rid = String(need?.requestID ?? "")
  check("readonly bash ask produced a permission request", rid.startsWith("per_"), rid)
  if (rid.startsWith("per_")) {
    const ans = sc(await call("oc_answer", { requestID: rid, kind: "permission", reply: "reject", message: "not needed", sessionID: sidB }))
    check("oc_answer with sessionID rejected the request (D1)", ans.ok === true, JSON.stringify(ans).slice(0, 140))
    await waitUntil([sidB], ["idle", "error"], undefined, 6)
  }

  // 7. close both
  const closeA = sc(await call("oc_close_session", { sessionID: sidA }))
  const closeB = sc(await call("oc_close_session", { sessionID: sidB }))
  check("close A + B", closeA.closed === true && closeB.closed === true, JSON.stringify({ a: closeA.closed, b: closeB.closed }))

  // 8. no zombie spam: bridge stderr log lines rate sanity (informational)
  say(`scratch: ${scratchRoot}`)
  say(failures === 0 ? "SMOKE: ALL CHECKS PASSED" : `SMOKE: ${failures} FAILURE(S)`)
  await client.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  say(`SMOKE CRASH: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
