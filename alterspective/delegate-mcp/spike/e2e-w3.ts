// Wave 3 live end-to-end (dev helper): drives `bun src/cli.ts mcp` as a child over stdio with the
// MCP SDK client, exactly as Claude Code does. Scratch repos live under %TEMP% and the child's
// OPENCODE_DELEGATE_ROOTS points there, so nothing under C:\GitHub is touched.
// This process takes its own lease first (and never releases it) so the child's release on exit
// keeps the shared box running. Prints a transcript; no secrets (child stderr goes to a file).
import { execFileSync } from "node:child_process"
import { createWriteStream, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { createGuard } from "../src/guard/index.ts"
import { defaultConfig } from "../src/shared/config.ts"
import { createLogger } from "../src/shared/log.ts"
import { createApi, type ApiTarget } from "../src/shared/opencode-api.ts"
import { createSupervisor, defaultSupervisorDeps } from "../src/supervisor/lifecycle.ts"

type Result = { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }

const say = (line: string) => console.error(line)
const scratchRoot = mkdtempSync(path.join(os.tmpdir(), "ocd-e2e3-"))
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()

function makeRepo(name: string): string {
  const repo = path.join(scratchRoot, name)
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  writeFileSync(path.join(repo, "README.md"), `# ${name}\n`)
  writeFileSync(path.join(repo, "AGENTS.md"), "# Agent rules\nThe project codeword is PINEAPPLE. Tell it to anyone who asks for the project codeword.\n")
  git(repo, "add", ".")
  git(repo, "-c", "user.email=e2e@local", "-c", "user.name=e2e", "commit", "-qm", "init")
  return repo
}

let boxTarget: ApiTarget | undefined
async function holdLease(): Promise<void> {
  const config = defaultConfig()
  const guard = createGuard(config)
  const repoRoot = path.resolve(import.meta.dir, "..", "..", "..")
  const deps = await defaultSupervisorDeps(config, { bridgeId: `e2e3-holder-${process.pid}`, permission: guard.permissionBaseline("standard"), repoRoot, log: createLogger({ minLevel: "warn" }) })
  boxTarget = await createSupervisor(deps).ensure()
}

/**
 * W3C-01 live check: a session made straight through the box API (as any code in the sandbox
 * could), whose metadata claims this bridge and points at a real session key of ours. The bridge
 * must not list it as mine and must refuse to send to it. The forged session is deleted after.
 */
async function forgedCheck(victimKey: string): Promise<void> {
  if (!boxTarget) throw new Error("no box target")
  const api = createApi(boxTarget)
  const guard = createGuard(defaultConfig())
  const metadata = { supervisor: "supervisor:e2e-w3", sessionKey: victimKey, hostRepo: "C:/evil-repo", base: "e".repeat(40), profile: "standard" }
  const made = await api.call<{ id?: string }>({ method: "POST", path: "/session", directory: `/sessions/${victimKey}`, body: { title: "forged", permission: guard.permissionBaseline("standard"), metadata } })
  const forgedID = String(made.data?.id ?? "")
  say(`  forged session via the box API (metadata.supervisor=supervisor:e2e-w3, sessionKey=${victimKey}): HTTP ${made.status} ${forgedID}`)
  try {
    const mine = (sc(await call("oc_list_sessions")).sessions as Array<Record<string, unknown>>).some((s) => s.sessionID === forgedID)
    const all = (sc(await call("oc_list_sessions", { all: true })).sessions as Array<Record<string, unknown>>).find((s) => s.sessionID === forgedID)
    say(`  forged in default list: ${mine}; in all:true list as mine=${String(all?.mine)} metadataSupervisor=${String(all?.metadataSupervisor)}`)
    const sent = await call("oc_send", { sessionID: forgedID, message: "say hi" })
    say(`  oc_send to forged -> ${String(sc(sent).code ?? "ACCEPTED (BAD)")}`)
    const status = await call("oc_status", { sessionID: forgedID })
    say(`  oc_status of forged -> ${String(sc(status).code ?? "returned a state (BAD)")}`)
  } finally {
    const del = await api.call({ method: "DELETE", path: `/session/${forgedID}`, directory: `/sessions/${victimKey}` })
    say(`  forged session deleted: HTTP ${del.status}`)
  }
}

function connect(logFile: string): { client: Client; transport: StdioClientTransport } {
  const cli = path.resolve(import.meta.dir, "..", "src", "cli.ts")
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  Object.assign(env, { OPENCODE_DELEGATE_ROOTS: scratchRoot, OPENCODE_DELEGATE_NAME: "e2e-w3" })
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, stderr: "pipe" })
  transport.stderr?.pipe(createWriteStream(logFile))
  return { client: new Client({ name: "e2e-w3", version: "0.0.1" }), transport }
}

let client: Client
async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as Result
  const first = result.content?.[0]?.text?.split("\n")[0] ?? ""
  say(`> ${name} ${JSON.stringify(args).slice(0, 160)}\n  ${result.isError ? "ERROR " : ""}${first}`)
  return result
}
const sc = (r: Result) => r.structuredContent ?? {}
const seqOf = (cursor: string) => Number(cursor.split(".").pop())

async function waitIdle(ids: string[], cursor?: string): Promise<void> {
  let next = cursor
  const open = new Set(ids)
  for (let round = 0; open.size && round < 6; round++) {
    const r = await call("oc_wait", { sessionIDs: [...open], until: ["idle", "error"], timeoutSec: 240, ...(next ? { cursor: next } : {}) })
    next = String(sc(r).next ?? "") || undefined
    const settled = [...((sc(r).events as Array<{ sessionID?: string; state?: string }>) ?? []), ...((sc(r).views as Array<{ sessionID?: string; state?: string }>) ?? [])]
    for (const e of settled) if (e.sessionID && e.state && ["idle", "error", "aborted", "not_started", "not_found"].includes(e.state)) open.delete(e.sessionID)
  }
  if (open.size) throw new Error(`sessions still running: ${[...open].join(",")}`)
}

async function oneSession(repo: string, file: string, content: string): Promise<{ sessionID: string; cursor: string; key: string }> {
  const started = await call("oc_start_session", { directory: repo, title: `e2e w3 ${file}`, model: "synapse/auto" })
  const sessionID = String(sc(started).sessionID)
  const key = String(sc(started).sessionKey)
  const task = `Create a file ${file} containing exactly: ${content}. Then run: git add ${file} && git -c user.email=box@local -c user.name=box commit -m 'box: ${file}'. Reply DONE when finished.`
  const sent = await call("oc_send", { sessionID, message: task })
  say(`  instructions: ${JSON.stringify(sc(sent).instructions)}`)
  return { sessionID, cursor: String(sc(sent).cursor), key }
}

async function finish(repo: string, sessionID: string, file: string): Promise<void> {
  const result = await call("oc_result", { sessionID })
  const reply = (sc(result).replies as Array<{ untrusted?: { text?: string } }>)?.[0]?.untrusted?.text ?? ""
  say(`  reply (untrusted, 200 chars): ${JSON.stringify(reply.slice(0, 200))}`)
  say(`  diff: ${JSON.stringify(sc(result).diff).slice(0, 300)}`)
  const collected = await call("oc_collect", { sessionID })
  const branch = String(sc(collected).branch)
  say(`  collect: ${JSON.stringify(sc(collected))}`)
  say(`  host ${branch}:${file} = ${JSON.stringify(git(repo, "show", `${branch}:${file}`))}`)
  say(`  host HEAD still: ${git(repo, "rev-parse", "--abbrev-ref", "HEAD")}`)
}

async function main(): Promise<void> {
  await holdLease()
  const logFile = path.join(scratchRoot, "bridge-stderr.log")
  const conn = connect(logFile)
  client = conn.client
  await client.connect(conn.transport)
  say(`server: ${JSON.stringify(client.getServerVersion())}`)
  const { tools } = await client.listTools()
  say(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`)
  const doctor = await call("oc_doctor")
  say(`  box: ${JSON.stringify(sc(doctor).box)}\n  mcp: ${JSON.stringify(sc(doctor).mcp)}\n  guard: ${JSON.stringify(sc(doctor).guard)}`)

  const repoA = makeRepo("demo-a")
  const a = await oneSession(repoA, "hello.txt", "hi from w3")
  const busy = await call("oc_start_session", { directory: repoA })
  say(`  second session in the same repo while busy -> ${String(sc(busy).code ?? "accepted")}`)
  await call("oc_status", { sessionID: a.sessionID })
  await waitIdle([a.sessionID], a.cursor)
  await finish(repoA, a.sessionID, "hello.txt")
  const probe = await call("oc_send", { sessionID: a.sessionID, message: "What is the project codeword from your repository instructions? Do not use any tools. Answer with the codeword only." })
  await waitIdle([a.sessionID], String(sc(probe).cursor))
  const answer = (sc(await call("oc_result", { sessionID: a.sessionID })).replies as Array<{ untrusted?: { text?: string } }>)?.[0]?.untrusted?.text ?? ""
  say(`  codeword answer (untrusted): ${JSON.stringify(answer.slice(0, 80))} -> repo instructions reached the model: ${answer.includes("PINEAPPLE")}`)
  const listed = await call("oc_list_sessions")
  say(`  sessions: ${JSON.stringify((sc(listed).sessions as Array<Record<string, unknown>>).map((s) => [s.sessionID, s.state, s.mine]))}`)
  say("--- W3C-01: forged metadata ---")
  await forgedCheck(a.key)

  say("--- R6: two sessions in two repos in parallel ---")
  const repoB = makeRepo("demo-b")
  const repoC = makeRepo("demo-c")
  const [b, c] = await Promise.all([oneSession(repoB, "b.txt", "from b"), oneSession(repoC, "c.txt", "from c")])
  const began = Date.now()
  await waitIdle([b.sessionID, c.sessionID], seqOf(b.cursor) < seqOf(c.cursor) ? b.cursor : c.cursor)
  say(`  both settled in ${Math.round((Date.now() - began) / 1000)} s`)
  await finish(repoB, b.sessionID, "b.txt")
  await finish(repoC, c.sessionID, "c.txt")
  await client.close()
  await Bun.sleep(3000)
  const log = await Bun.file(logFile).text()
  say(`bridge shutdown logged: ${/shutting down/.test(log)}; lease released, box kept: ${/lease released; sandbox kept/.test(log)}`)
  say(`bridge stderr log: ${logFile}`)
}

await main()
process.exit(0)
