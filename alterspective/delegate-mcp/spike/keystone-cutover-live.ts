// Live cutover check for #67: run the real bridge as an MCP server with OCD_KEYSTONE_HOST_AUTH=1 (no client
// config change), start the box, sign in on the host per Keystone connection (the owner approves in the
// browser), then read oc_doctor. Prints tool results only after checking they carry no token-like text.
// Run: bun spike/keystone-cutover-live.ts [ks-<id> ...]   (default: every chosen connection)
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const LONG = { timeout: 15 * 60_000, resetTimeoutOnProgress: true, maxTotalTimeout: 20 * 60_000 }
// A compact JWT or a long opaque bearer must never appear in any result.
const TOKEN_LIKE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.|Bearer\s+[A-Za-z0-9._-]{20,}/

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
  if (TOKEN_LIKE.test(text)) throw new Error(`${name}: result contains token-like text; not printed`)
  const blocks = (result.content as { type: string; text?: string }[] | undefined) ?? []
  const summary = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")
  console.error(`\n=== ${name} ${JSON.stringify(args)}${result.isError ? " (ERROR)" : ""}\n${summary.slice(0, 4000)}`)
  return result
}

// --hold=<seconds>: no sign-in; keep the box up (probes, forced refresh), then read oc_doctor again.
const hold = Number(process.argv.find((a) => a.startsWith("--hold="))?.slice(7) ?? "0")

try {
  await call("oc_list_sessions") // starts the box if needed
  if (hold > 0) {
    await call("oc_doctor")
    console.error(`\nHOLDING ${hold}s (box up for probes)`)
    await new Promise((resolve) => setTimeout(resolve, hold * 1000))
    await call("oc_doctor")
    process.exit(0)
  }
  const servers = process.argv.slice(2).filter((a) => a.startsWith("ks-"))
  if (servers.length === 0) {
    console.error("\nSigning in to every chosen connection; approve each browser tab.")
    await call("oc_login")
  } else {
    for (const server of servers) {
      console.error(`\nSigning in to ${server}; approve the browser tab.`)
      await call("oc_login", { server })
    }
  }
  await call("oc_doctor")
} finally {
  await client.close()
}
