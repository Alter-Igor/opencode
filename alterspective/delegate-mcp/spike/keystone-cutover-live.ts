// Live cutover check for #67: run the real bridge as an MCP server with OCD_KEYSTONE_HOST_AUTH=1 (no client
// config change), start the box, sign in on the host per Keystone connection (the owner approves in the
// browser), then read oc_doctor. Prints tool results only after checking they carry no token-like text.
// Run: bun spike/keystone-cutover-live.ts [ks-<id> ...]   (default: every chosen connection)
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const LONG = { timeout: 15 * 60_000, resetTimeoutOnProgress: true, maxTotalTimeout: 20 * 60_000 }
// Nothing that could be a credential is ever printed. Runs of 24+ token characters are refused unless they
// are plainly safe diagnostic text: an exact UUID or client id (dcr-<uuid>) or an ISO time. Any mixed-case
// run with digits (JWTs, opaque bearers), and any other run of 32+ characters without a dot or slash (hex or
// base64 refresh tokens; URLs and paths have dots or slashes), refuses the whole result.
const TOKEN_RUN = /[A-Za-z0-9._~+/=-]{24,}/g
const UUID = /^(dcr-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function looksSecret(text: string): boolean {
  for (const run of text.match(TOKEN_RUN) ?? []) {
    if (UUID.test(run) || /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(run)) continue
    if (/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run)) return true
    if (run.length >= 32 && !/[./]/.test(run)) return true
  }
  return false
}

const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))
const transport = new StdioClientTransport({
  command: "bun",
  args: [path.join(import.meta.dir, "..", "src", "cli.ts"), "mcp"],
  env: { ...env, OCD_KEYSTONE_HOST_AUTH: "1", OPENCODE_DELEGATE_NAME: env.OPENCODE_DELEGATE_NAME ?? "ks67-live-check" },
  stderr: "ignore",
})
const client = new Client({ name: "ks67-live-check", version: "0.0.0" })
await client.connect(transport)

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, LONG)
  const text = JSON.stringify(result)
  if (looksSecret(text)) throw new Error(`${name}: result contains credential-like text; not printed`)
  const blocks = (result.content as { type: string; text?: string }[] | undefined) ?? []
  const summary = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")
  console.error(`\n=== ${name} ${JSON.stringify(args)}${result.isError ? " (ERROR)" : ""}\n${summary.slice(0, 4000)}`)
  // A tool failure is a failed check, never a printed warning.
  if (result.isError) throw new Error(`${name} reported an error`)
  return { result, summary }
}

function requireLoginConnected(server: string, text: string) {
  if (!/"result":\s*"connected"/.test(text) || !/"box":\s*"connected"/.test(text)) throw new Error(`oc_login ${server}: not connected on the host and in the box`)
}

function requireVerified(text: string) {
  if (!/"verified":\s*true/.test(text)) throw new Error("oc_doctor: not verified")
  if (!/"keystoneAuth":\s*\{\s*"enabled":\s*true,\s*"ok":\s*true/.test(text)) throw new Error("oc_doctor: keystoneAuth not ok")
}

// --hold=<seconds>: no sign-in; keep the box up (probes, forced refresh), then read oc_doctor again.
const hold = Number(process.argv.find((a) => a.startsWith("--hold="))?.slice(7) ?? "0")

try {
  await call("oc_list_sessions") // starts the box if needed
  if (hold > 0) {
    // The first reading may say "Docker health starting"; only the final one must be verified.
    await call("oc_doctor")
    console.error(`\nHOLDING ${hold}s (box up for probes)`)
    await new Promise((resolve) => setTimeout(resolve, hold * 1000))
  } else {
    const servers = process.argv.slice(2).filter((a) => a.startsWith("ks-"))
    if (servers.length === 0) {
      console.error("\nSigning in to every chosen connection; approve each browser tab.")
      await call("oc_login")
    } else {
      for (const server of servers) {
        console.error(`\nSigning in to ${server}; approve the browser tab.`)
        requireLoginConnected(server, (await call("oc_login", { server })).summary)
      }
    }
  }
  requireVerified((await call("oc_doctor")).summary)
  console.error("\nLIVE CHECK PASSED")
} finally {
  await client.close()
}
