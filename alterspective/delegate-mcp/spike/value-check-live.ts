// Live value check for #71-#73: run the real bridge (this checkout) as an MCP server under its own name,
// then measure each value item against the real box and Synapse. Uses a scratch repo the caller names.
// Prints tool results only after checking they carry no token-like text. Does not change any client config.
// Run: bun spike/value-check-live.ts <scratch-repo-dir>
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const LONG = { timeout: 20 * 60_000, resetTimeoutOnProgress: true, maxTotalTimeout: 25 * 60_000 }
// Same guard as keystone-cutover-live.ts: refuse any result with a run that could be a credential.
const TOKEN_RUN = /[A-Za-z0-9._~+/=-]{24,}/g
const UUID = /^(dcr-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// The session web link (oc_start_session) holds the box folder base64url-encoded: not a credential.
const WEB_URL = /https?:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/session\/ses_[A-Za-z0-9]+/g
// Event cursors ("<epoch>.<seq>", the epoch a random id) in `cursor` / `next` fields: not credentials.
const CURSOR_FIELD = /(\\?"(?:cursor|next)\\?":\\?")[A-Za-z0-9-]{1,64}\.\d{1,15}/g
/** The field name and length of the first credential-like run, or undefined. Never the value. */
function looksSecret(raw: string): string | undefined {
  const text = raw.replace(WEB_URL, "<webUrl>").replace(CURSOR_FIELD, "$1<cursor>")
  for (const m of text.matchAll(TOKEN_RUN)) {
    // A sentence's full stop can trail an id ("Accepted by ses_...."); it is not part of the run.
    const run = m[0].replace(/\.+$/, "")
    if (UUID.test(run) || /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(run)) continue
    // OpenCode ids (session, message, part, permission, question) and git commit ids.
    if (/^(ses|msg|prt|per|que)_[A-Za-z0-9]{20,}$/.test(run) || /^[0-9a-f]{40}$/.test(run)) continue
    const where = () => `${text.slice(Math.max(0, (m.index ?? 0) - 24), m.index).replace(/[A-Za-z0-9+/=_-]{12,}/g, "<run>")} [${run.length} chars]`
    if (/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run)) return where()
    if (run.length >= 32 && !/[./]/.test(run)) return where()
  }
  return undefined
}

const repo = process.argv[2]
if (!repo) throw new Error("usage: bun spike/value-check-live.ts <scratch-repo-dir>")
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))
const transport = new StdioClientTransport({
  command: "bun",
  args: [path.join(import.meta.dir, "..", "src", "cli.ts"), "mcp"],
  env: { ...env, OCD_KEYSTONE_HOST_AUTH: "1", OPENCODE_DELEGATE_NAME: "value-check" },
  stderr: "ignore",
})
const client = new Client({ name: "value-check", version: "0.0.0" })
await client.connect(transport)

type Result = { isError: boolean; data: Record<string, unknown> }
async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const result = await client.callTool({ name, arguments: args }, undefined, LONG)
  const text = JSON.stringify(result)
  const flagged = looksSecret(text)
  if (flagged) throw new Error(`${name}: result contains credential-like text after: ${flagged}; not printed`)
  const structured = (result.structuredContent as Record<string, unknown> | undefined) ?? {}
  const blocks = (result.content as { type: string; text?: string }[] | undefined) ?? []
  const summary = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")
  console.error(`\n=== ${name} ${JSON.stringify(args)}${result.isError ? " (ERROR)" : ""}\n${summary.slice(0, 3000)}`)
  let data = structured
  if (!Object.keys(data).length) {
    try {
      data = JSON.parse(summary) as Record<string, unknown>
    } catch {
      data = { text: summary }
    }
  }
  return { isError: result.isError === true, data }
}

const checks: { item: string; check: string; pass: boolean; observed: string }[] = []
const record = (item: string, check: string, pass: boolean, observed: unknown) => {
  checks.push({ item, check, pass, observed: typeof observed === "string" ? observed : JSON.stringify(observed) })
  console.error(`\n[${pass ? "PASS" : "FAIL"}] ${item}: ${check}`)
}

async function runTask(message: string): Promise<string> {
  const started = await call("oc_start_session", { directory: repo, title: "value check" })
  const sessionID = String(started.data.sessionID)
  const sent = await call("oc_send", { sessionID, message })
  let cursor = String(sent.data.cursor)
  for (let i = 0; i < 12; i++) {
    const waited = await call("oc_wait", { sessionIDs: [sessionID], cursor, timeoutSec: 240 })
    cursor = String(waited.data.cursor ?? cursor)
    const states = JSON.stringify(waited.data)
    if (/"(idle|error|needs_input)"/.test(states)) break
  }
  await call("oc_result", { sessionID })
  return sessionID
}

try {
  // A run that stopped early can leave this bridge's own sessions: close them first (only "value-check").
  const mine = await call("oc_list_sessions")
  for (const id of JSON.stringify(mine.data).match(/ses_[A-Za-z0-9]{20,}/g) ?? []) await call("oc_close_session", { sessionID: id, abort: true, discardWork: true })

  // #71: models are Synapse only, default synapse/auto; another provider is refused.
  const models = await call("oc_list_models")
  const ids = JSON.stringify(models.data).match(/"[a-z0-9-]+\/[A-Za-z0-9._:@/-]+"/g)?.map((s) => s.slice(1, -1)) ?? []
  const modelIds = ids.filter((id) => !id.startsWith("ks-") && !id.startsWith("mcp/"))
  record("#71", "every offered model is synapse/<id>", modelIds.length > 0 && modelIds.every((id) => id.startsWith("synapse/")), modelIds)
  record("#71", "synapse/auto is offered", modelIds.includes("synapse/auto"), modelIds.includes("synapse/auto"))
  const probe = await call("oc_start_session", { directory: repo, model: "opencode/big-pickle" })
  record("#71", "a non-Synapse model is refused", probe.isError && JSON.stringify(probe.data).includes("invalid_input"), probe.data.code ?? probe.data)

  const before = await call("oc_list_sessions", { all: true })

  // #73 + #72: task A changes a file and commits; collect, merge locally, close with deleteBranch.
  const a = await runTask("Create a file named value-check.txt containing the single line 'value check'. Then run git add and git commit with the message 'value check'. Do nothing else.")
  const collected = await call("oc_collect", { sessionID: a })
  const branch = JSON.stringify(collected.data).match(/delegate\/[A-Za-z0-9._-]+/)?.[0] ?? ""
  record("#72", "collect fetched a delegate branch", /^delegate\//.test(branch), branch)
  const merge = Bun.spawnSync(["git", "-C", repo, "merge", "--no-edit", "--no-ff", branch])
  record("#72", "the collected branch merges into the scratch repo", merge.exitCode === 0, `git merge exit ${merge.exitCode}`)
  const closedA = await call("oc_close_session", { sessionID: a, deleteBranch: true })
  record("#72", "close removes session, copy, record and the merged branch", closedA.data.closed === true && closedA.data.branch === "deleted", closedA.data)

  // Task B: no file change; close is clean.
  const b = await runTask("Reply with the single word done. Do not create, change or commit any file.")
  const closedB = await call("oc_close_session", { sessionID: b })
  record("#72", "a clean session closes", closedB.data.closed === true, closedB.data)

  const after = await call("oc_list_sessions", { all: true })
  // The list's header names this bridge's supervisor, so check the closed ids and `mine` rows instead.
  const afterText = JSON.stringify(after.data)
  const leftover = [a, b].filter((id) => afterText.includes(id))
  record("#72", "neither closed session is left in the sandbox, and none is this bridge's", leftover.length === 0 && !/"mine":\s*true/.test(afterText), { leftover, before: before.data.text ?? "", after: after.data.text ?? "" })
  const sweep = await call("oc_cleanup", { dryRun: true })
  record("#72", "oc_cleanup dry run answers", !sweep.isError, sweep.data)

  // #73: both tasks are in the report.
  const report = await call("oc_report", { sinceDays: 1, groupBy: "model", recent: 5 })
  const totals = report.data.totals as { tasks?: number; finished?: number } | undefined
  record("#73", "oc_report counts the tasks of this run", (totals?.tasks ?? 0) >= 2, totals)
  record("#73", "oc_report carries notes", Array.isArray(report.data.notes), report.data.notes)

} finally {
  await client.close()
}

console.error("\n=== SUMMARY")
for (const c of checks) console.error(`${c.pass ? "PASS" : "FAIL"} ${c.item} ${c.check}: ${c.observed.slice(0, 300)}`)
console.log(JSON.stringify(checks, null, 2))
if (checks.some((c) => !c.pass)) process.exitCode = 1
