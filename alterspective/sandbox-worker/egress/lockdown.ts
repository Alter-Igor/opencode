// #118: run as ROOT, before the supervisor, inside the sandbox:
//   SBXW_EGRESS_ALLOW="203.0.113.10:443" [SBXW_EGRESS_DNS=…] bun /opt/sbxw/egress/lockdown.ts
// Exits non-zero on any failure. The caller must not start the supervisor if it does.
// It refuses to run once any process of the agent user (SBXW_AGENT_USER, default "agent") exists:
// a connection opened before lockdown can survive it (see preflight.ts).
import { $ } from "bun"
import { pidsOwnedBy } from "./preflight"
import { TABLE, parseAllow, renderRuleset } from "./rules"

/** Print the reason and exit 1: the caller must then not start the supervisor. */
const fail = (message: string): never => {
  console.error(`[sbxw-egress] ${message}`)
  process.exit(1)
}

if (process.getuid?.() !== 0) fail("must run as root")
const agentUser = process.env.SBXW_AGENT_USER || "agent"
const agentUid = await $`id -u ${agentUser}`.nothrow().quiet()
if (agentUid.exitCode === 0) {
  const running = pidsOwnedBy(Number(agentUid.text().trim()))
  if (running.length > 0) fail(`${agentUser} already has ${running.length} process(es); lock down before the agent starts`)
}
let ruleset: string
try {
  ruleset = renderRuleset({ allow: parseAllow(process.env.SBXW_EGRESS_ALLOW), dns: process.env.SBXW_EGRESS_DNS || undefined })
} catch (error) {
  fail(`bad configuration: ${error instanceof Error ? error.message : String(error)}`)
}
const file = "/run/sbxw-egress.nft"
await Bun.write(file, ruleset!)
const applied = await $`nft -f ${file}`.nothrow().quiet()
if (applied.exitCode !== 0) fail(`nft -f failed: ${applied.stderr.toString().trim()}`)
const v4 = (await $`nft list table ip ${TABLE}`.nothrow().quiet().text()).trim()
const v6 = (await $`nft list table ip6 ${TABLE}`.nothrow().quiet().text()).trim()
if (!/policy drop/.test(v4) || !/comment "metadata"/.test(v4)) fail("the ip table did not load as expected")
if (!/policy drop/.test(v6) || !/comment "ipv6"/.test(v6) || !/comment "ipv6-link-local"/.test(v6)) fail("the ip6 table did not load as expected")
console.log(`[sbxw-egress] locked down: tables ip and ip6 ${TABLE}, policy drop`)
