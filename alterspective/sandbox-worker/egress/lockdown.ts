// #118: run as ROOT, before the supervisor, inside the sandbox:
//   SBXW_EGRESS_ALLOW="203.0.113.10:443" [SBXW_EGRESS_DNS=…] bun /opt/sbxw/egress/lockdown.ts
// Exits non-zero on any failure. The caller must not start the supervisor if it does.
import { $ } from "bun"
import { TABLE, parseAllow, renderRuleset } from "./rules"

const fail = (message: string): never => {
  console.error(`[sbxw-egress] ${message}`)
  process.exit(1)
}

if (process.getuid?.() !== 0) fail("must run as root")
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
if (!/policy drop/.test(v6) || !/comment "ipv6"/.test(v6)) fail("the ip6 table did not load as expected")
console.log(`[sbxw-egress] locked down: tables ip and ip6 ${TABLE}, policy drop`)
